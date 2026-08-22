/**
 * Error responses.
 *
 * docs/api.qmd promises RFC 9457 for every error, and the promise is only worth anything if it also
 * covers the errors nobody wrote a handler for: a 404 on a route that does not exist, and a throw
 * from inside a handler. Those are the two the tests below go after, because they are the ones a
 * framework will happily answer in its own format if left alone.
 */
import { CORE_PROBLEM_TYPES, ProblemDetailsSchema } from '@recueil/schemas';
import { NotFoundError } from '@recueil/core';
import { describe, expect, it } from 'vitest';

import { harness } from './helpers.js';

describe('an unknown route', () => {
  it('returns a problem+json 404', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'GET', url: '/no/such/route' });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/u);

      const problem = ProblemDetailsSchema.parse(response.json());
      expect(problem.type).toBe(CORE_PROBLEM_TYPES.notFound);
      expect(problem.status).toBe(404);
      expect(problem.title).toBe('Not found');
      expect(problem.instance).toBe('/no/such/route');
      expect(problem.detail).toContain('GET /no/such/route');
      expect(problem.traceId).toBe(response.headers['x-request-id']);
    } finally {
      await h.close();
    }
  });

  it('does the same for a method that is not routed', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'POST', url: '/health' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/u);
      expect(ProblemDetailsSchema.parse(response.json()).type).toBe(CORE_PROBLEM_TYPES.notFound);
    } finally {
      await h.close();
    }
  });
});

describe('an error thrown by a handler', () => {
  it('maps a core NotFoundError onto its problem type', async () => {
    const h = await harness({
      routes: (app) => {
        app.get('/test/missing', async () => {
          throw new NotFoundError('item', '01J8F3Z9K4ABCDEFGHJKMNPQRS');
        });
      },
    });
    try {
      const response = await h.app.inject({ method: 'GET', url: '/test/missing' });
      expect(response.statusCode).toBe(404);

      const problem = ProblemDetailsSchema.parse(response.json());
      expect(problem.type).toBe(CORE_PROBLEM_TYPES.notFound);
      expect(problem.detail).toContain('01J8F3Z9K4ABCDEFGHJKMNPQRS');
    } finally {
      await h.close();
    }
  });

  it('says nothing about an unexpected failure beyond that it happened', async () => {
    const h = await harness({
      routes: (app) => {
        app.get('/test/boom', async () => {
          throw new Error('/var/lib/recueil/secret.db is on fire');
        });
      },
    });
    try {
      const response = await h.app.inject({ method: 'GET', url: '/test/boom' });
      expect(response.statusCode).toBe(500);
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/u);

      const problem = ProblemDetailsSchema.parse(response.json());
      expect(problem.type).toBe(CORE_PROBLEM_TYPES.internal);
      expect(problem.title).toBe('Internal server error');
      expect(problem.detail).toBeUndefined();
      expect(JSON.stringify(problem)).not.toContain('secret.db');
      expect(problem.traceId).toBe(response.headers['x-request-id']);
    } finally {
      await h.close();
    }
  });
});

describe('request ids', () => {
  it('mints one and echoes it', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'GET', url: '/health' });
      const id = response.headers['x-request-id'];
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    } finally {
      await h.close();
    }
  });

  it('honours one supplied by a proxy', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'GET',
        url: '/no/such/route',
        headers: { 'x-request-id': 'from-the-proxy' },
      });
      expect(response.headers['x-request-id']).toBe('from-the-proxy');
      expect(ProblemDetailsSchema.parse(response.json()).traceId).toBe('from-the-proxy');
    } finally {
      await h.close();
    }
  });
});
