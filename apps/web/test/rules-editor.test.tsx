/**
 * The rules editor, end to end within the browser.
 *
 * Two views over one table, so what is asserted is that they agree and that neither loses anything:
 * a form edit is a `PATCH` of one row, a text edit is diffed into the smallest set of requests that
 * makes the table say what the document says, and an invalid document stops both the save and the
 * dry run rather than being sent for the server to refuse.
 */
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RulesEditor } from '../src/rules/rules-editor.js';
import { createFakeServer } from './fake-server.js';
import type { FakeServer, Handler } from './fake-server.js';
import { renderWithApi } from './helpers.js';
import {
  DOCUMENT_ID,
  NESTED_RULE_ROW_ID,
  RULE_ROW_ID,
  dryRunResponse,
  nestedRule,
  page,
  reviewEntry,
  scanDocument,
  scannerRule,
} from './ingestion-fixtures.js';

const RULES = '/api/v1/rules';

const Harness = (): JSX.Element => {
  const [selected, setSelected] = useState<string | null>(null);
  return <RulesEditor selectedRuleId={selected} onSelect={setSelected} />;
};

const render = (routes: Record<string, Handler> = {}): { server: FakeServer } => {
  const server = createFakeServer({
    [`GET ${RULES}`]: () => page([scannerRule(), nestedRule()]),
    ...routes,
  });
  renderWithApi(<Harness />, server);
  return { server };
};

const yamlView = async (): Promise<HTMLTextAreaElement> => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'YAML' }));
  return (await screen.findByTestId('rules-yaml')) as HTMLTextAreaElement;
};

describe('the rules editor', () => {
  it('lists the rules in evaluation order, in plain words', async () => {
    render();
    await screen.findByTestId('rules-form');
    expect(screen.getByText('scanner-by-folder')).toBeInTheDocument();
    expect(screen.getByText(/source equals "scanner"/u)).toBeInTheDocument();
    expect(screen.getByText('file it under Office/Scans')).toBeInTheDocument();
  });

  it('shows a rule the form cannot represent read-only, and says why', async () => {
    render();
    await screen.findByTestId('rules-form');
    expect(screen.getByTestId('rule-complex-nested-rule')).toHaveTextContent(
      'nested, negated or uses a resolver',
    );
  });

  it('patches one row when a rule is edited in the form', async () => {
    const user = userEvent.setup();
    const { server } = render({ [`PATCH ${RULES}/:id`]: () => scannerRule({ priority: 200 }) });

    await screen.findByTestId('rules-form');
    const row = screen.getByText('scanner-by-folder').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Edit' }));

    const priority = screen.getByLabelText('Priority');
    await user.clear(priority);
    await user.type(priority, '200');
    await user.click(screen.getByRole('button', { name: 'Save the rule' }));

    await waitFor(() => {
      expect(server.requestsTo('PATCH', `${RULES}/${RULE_ROW_ID}`)).toHaveLength(1);
    });
    expect(server.requestsTo('PATCH', `${RULES}/${RULE_ROW_ID}`)[0]?.body).toMatchObject({
      priority: 200,
      when: { type: 'source', match: { equals: 'scanner' } },
    });
  });

  it('renders the table as one document, and reports it as valid against the engine’s schema', async () => {
    render();
    const text = await yamlView();
    expect(text.value).toContain('id: scanner-by-folder');
    expect(text.value).toContain('kind: ingestion');
    const banner = await screen.findByTestId('rules-valid');
    expect(banner).toHaveTextContent('valid');
    expect(banner).toHaveTextContent('rule-set.schema.json');
  });

  it('says nothing needs saving until the document changes', async () => {
    render();
    await yamlView();
    expect(screen.getByTestId('rules-diff')).toHaveTextContent('Nothing to save.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('says what saving will do before it does it', async () => {
    render();
    const text = await yamlView();
    fireEvent.change(text, { target: { value: text.value.replace('priority: 100', 'priority: 250') } });
    expect(await screen.findByTestId('rules-diff')).toHaveTextContent('Will change 1 rule.');
  });

  it('saves a text edit as the smallest set of requests that makes the table match', async () => {
    const user = userEvent.setup();
    const { server } = render({
      [`PATCH ${RULES}/:id`]: () => scannerRule({ priority: 250 }),
      [`DELETE ${RULES}/:id`]: () => undefined,
      [`POST ${RULES}`]: () => scannerRule(),
    });

    const text = await yamlView();
    const edited = text.value
      .replace('priority: 100', 'priority: 250')
      // Drop the second rule entirely.
      .replace(/ {2}- id: nested-rule[\s\S]*$/u, '');
    fireEvent.change(text, { target: { value: edited } });
    await user.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(server.requestsTo('DELETE', `${RULES}/${NESTED_RULE_ROW_ID}`)).toHaveLength(1);
    });
    expect(server.requestsTo('PATCH', `${RULES}/${RULE_ROW_ID}`)).toHaveLength(1);
    // Nothing was created, and the untouched rule was not rewritten.
    expect(server.requestsTo('POST', RULES)).toHaveLength(0);
  });

  it('refuses to save an invalid document, and says what is wrong', async () => {
    const { server } = render({ [`PATCH ${RULES}/:id`]: () => scannerRule() });
    const text = await yamlView();
    fireEvent.change(text, { target: { value: 'version: 1\nkind: ingestion\nrules: notalist\n' } });

    expect(await screen.findByTestId('rules-invalid')).toHaveTextContent('not valid');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(server.requestsTo('PATCH', `${RULES}/${RULE_ROW_ID}`)).toHaveLength(0);
  });

  it('runs a dry run over the review queue, asking the documents themselves for the subjects', async () => {
    const user = userEvent.setup();
    const { server } = render({
      [`GET /api/v1/ingestion/review`]: () => page([reviewEntry()]),
      [`GET /api/v1/documents/:id`]: () => scanDocument(),
      [`POST ${RULES}/dry-run`]: () => dryRunResponse(),
    });

    await screen.findByTestId('rules-form');
    await user.click(screen.getByRole('button', { name: 'Run over the review queue' }));

    const report = await screen.findByTestId('dry-run-report');
    expect(report).toHaveTextContent('1 would change');
    expect(server.requestsTo('GET', `/api/v1/documents/${DOCUMENT_ID}`)).toHaveLength(1);

    const body = server.requestsTo('POST', `${RULES}/dry-run`)[0]?.body as {
      subjects: { id: string; source?: string; path?: string; mime?: string }[];
      rules?: unknown[];
    };
    expect(body.subjects[0]).toMatchObject({
      id: DOCUMENT_ID,
      source: 'scanner',
      path: '/srv/consume/scans/Acme GmbH/scan-0042.pdf',
      mime: 'application/pdf',
    });
    // Nothing unsaved is open, so the stored rules are run and no inline set is sent.
    expect(body.rules).toBeUndefined();
  });

  it('runs an unsaved document rather than the stored rules when the text view holds one', async () => {
    const user = userEvent.setup();
    const { server } = render({ [`POST ${RULES}/dry-run`]: () => dryRunResponse() });

    const text = await yamlView();
    fireEvent.change(text, { target: { value: text.value.replace('priority: 100', 'priority: 250') } });
    await user.type(screen.getByLabelText('Filename'), 'invoice-114.pdf');
    await user.click(screen.getByRole('button', { name: 'Run over this subject' }));

    await waitFor(() => {
      expect(server.requestsTo('POST', `${RULES}/dry-run`)).toHaveLength(1);
    });
    const body = server.requestsTo('POST', `${RULES}/dry-run`)[0]?.body as {
      rules: { ruleId: string; priority?: number }[];
      subjects: { filename?: string }[];
    };
    expect(body.rules.find((rule) => rule.ruleId === 'scanner-by-folder')?.priority).toBe(250);
    expect(body.subjects[0]?.filename).toBe('invoice-114.pdf');
  });

  it('shows what the rules would set, attributed to the rule that would set it', async () => {
    const user = userEvent.setup();
    render({ [`POST ${RULES}/dry-run`]: () => dryRunResponse() });

    await screen.findByTestId('rules-form');
    await user.type(screen.getByLabelText('Filename'), 'invoice-114.pdf');
    await user.click(screen.getByRole('button', { name: 'Run over this subject' }));

    const changes = await screen.findByTestId('dry-run-changes');
    expect(changes).toHaveTextContent('item type');
    expect(changes).toHaveTextContent('invoice');
    expect(changes).toHaveTextContent('by scanner-by-folder');
  });

  it('marks a rule that never fires, because a dead rule looks authoritative', async () => {
    const user = userEvent.setup();
    render({ [`POST ${RULES}/dry-run`]: () => dryRunResponse() });

    await screen.findByTestId('rules-form');
    await user.click(screen.getByRole('button', { name: 'Run over this subject' }));
    await screen.findByTestId('dry-run-report');

    const row = document.querySelector('tr[data-rule="nested-rule"]') as HTMLElement;
    expect(row).toHaveAttribute('data-dead', 'true');
    expect(within(row).getByText('never fires')).toBeInTheDocument();
  });

  it('lists the subjects no rule matched, which is the number M2 is judged on', async () => {
    const user = userEvent.setup();
    render({ [`POST ${RULES}/dry-run`]: () => dryRunResponse() });
    await screen.findByTestId('rules-form');
    await user.click(screen.getByRole('button', { name: 'Run over this subject' }));
    expect(await screen.findByTestId('dry-run-unmatched')).toHaveTextContent('doc-3');
  });

  it('offers a starting document to a library with no rules', async () => {
    render({ [`GET ${RULES}`]: () => page([]) });
    expect(await screen.findByText('No rules')).toBeInTheDocument();
    const text = await yamlView();
    expect(text.value).toContain('kind: ingestion');
    expect(await screen.findByTestId('rules-valid')).toBeInTheDocument();
  });
});
