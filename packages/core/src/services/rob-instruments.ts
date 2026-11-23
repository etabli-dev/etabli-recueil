/**
 * Risk-of-bias instruments as data (CONCEPT §5.10 item 8, `spec/systematic-review.md` §6).
 *
 * Each instrument lists its domains, the signalling questions of each domain with their answer
 * options, and the judgement levels. The definition is copied into every assessment, so a later
 * revision of an instrument cannot rewrite an old judgement (`spec/data-model.md` §8.7).
 *
 * `robvis` names the judgement labels and the tool name the robvis R package expects, so the
 * traffic-light export needs no reshaping (RB1). The question wording is abbreviated; the
 * published guidance documents remain the reference for how to answer them.
 */

export interface RobQuestion {
  key: string;
  text: string;
  answers: readonly string[];
}

export interface RobDomain {
  key: string;
  name: string;
  questions: readonly RobQuestion[];
}

export interface RobInstrument {
  tool: string;
  version: string;
  name: string;
  domains: readonly RobDomain[];
  /** The judgement levels, best to worst; the overall proposal takes the worst domain. */
  levels: readonly string[];
  /** Levels that are not on the best-to-worst scale (`no_information`). */
  otherLevels: readonly string[];
  robvis: { tool: string; labels: Record<string, string> } | null;
  /** Whether the instrument's own guidance makes the overall judgement the worst domain. */
  worstDomainOverall: boolean;
}

const YN = ['Y', 'PY', 'PN', 'N', 'NI'] as const;
const YNA = ['Y', 'PY', 'PN', 'N', 'NI', 'NA'] as const;
const q = (key: string, text: string, answers: readonly string[] = YNA): RobQuestion => ({ key, text, answers });

export const ROB_INSTRUMENTS: Record<string, RobInstrument> = {
  rob2: {
    tool: 'rob2',
    version: '2019-08-22',
    name: 'RoB 2 (randomised trials)',
    domains: [
      { key: 'D1', name: 'Bias arising from the randomization process', questions: [q('1.1', 'Was the allocation sequence random?', YN), q('1.2', 'Was the allocation sequence concealed until participants were enrolled and assigned?', YN), q('1.3', 'Did baseline differences suggest a problem with randomization?', YN)] },
      { key: 'D2', name: 'Bias due to deviations from intended interventions', questions: [q('2.1', 'Were participants aware of their assigned intervention?', YN), q('2.2', 'Were carers and people delivering the interventions aware?', YN), q('2.3', 'Were there deviations that arose because of the trial context?'), q('2.6', 'Was an appropriate analysis used to estimate the effect of assignment?', YN)] },
      { key: 'D3', name: 'Bias due to missing outcome data', questions: [q('3.1', 'Were data available for all, or nearly all, participants?', YN), q('3.2', 'Is there evidence that the result was not biased by missing data?'), q('3.3', 'Could missingness depend on its true value?')] },
      { key: 'D4', name: 'Bias in measurement of the outcome', questions: [q('4.1', 'Was the method of measuring the outcome inappropriate?', YN), q('4.2', 'Could measurement have differed between groups?', YN), q('4.3', 'Were outcome assessors aware of the intervention received?'), q('4.4', 'Could assessment have been influenced by that knowledge?')] },
      { key: 'D5', name: 'Bias in selection of the reported result', questions: [q('5.1', 'Was the analysis done according to a pre-specified plan?', YN), q('5.2', 'Was the result selected from multiple outcome measurements?', YN), q('5.3', 'Was the result selected from multiple analyses?', YN)] },
    ],
    levels: ['low', 'some_concerns', 'high'],
    otherLevels: ['no_information'],
    robvis: { tool: 'ROB2', labels: { low: 'Low', some_concerns: 'Some concerns', high: 'High', no_information: 'No information' } },
    worstDomainOverall: true,
  },
  robins_i: {
    tool: 'robins_i',
    version: '2016-10-20',
    name: 'ROBINS-I (non-randomised studies of interventions)',
    domains: [
      { key: 'D1', name: 'Bias due to confounding', questions: [q('1.1', 'Is there potential for confounding of the effect of intervention?')] },
      { key: 'D2', name: 'Bias due to selection of participants', questions: [q('2.1', 'Was selection into the study based on characteristics observed after the start of intervention?')] },
      { key: 'D3', name: 'Bias in classification of interventions', questions: [q('3.1', 'Were intervention groups clearly defined?')] },
      { key: 'D4', name: 'Bias due to deviations from intended interventions', questions: [q('4.1', 'Were there deviations beyond what is expected in usual practice?')] },
      { key: 'D5', name: 'Bias due to missing data', questions: [q('5.1', 'Were outcome data available for all, or nearly all, participants?')] },
      { key: 'D6', name: 'Bias in measurement of outcomes', questions: [q('6.1', 'Could the outcome measure have been influenced by knowledge of the intervention received?')] },
      { key: 'D7', name: 'Bias in selection of the reported result', questions: [q('7.1', 'Is the reported result likely to be selected from multiple measurements or analyses?')] },
    ],
    levels: ['low', 'moderate', 'serious', 'critical'],
    otherLevels: ['no_information'],
    robvis: { tool: 'ROBINS-I', labels: { low: 'Low', moderate: 'Moderate', serious: 'Serious', critical: 'Critical', no_information: 'No information' } },
    worstDomainOverall: true,
  },
  quadas2: {
    tool: 'quadas2',
    version: '2011',
    name: 'QUADAS-2 (diagnostic accuracy)',
    domains: [
      { key: 'D1', name: 'Patient selection', questions: [q('1.1', 'Was a consecutive or random sample of patients enrolled?', YN), q('1.2', 'Was a case-control design avoided?', YN), q('1.3', 'Did the study avoid inappropriate exclusions?', YN)] },
      { key: 'D2', name: 'Index test', questions: [q('2.1', 'Were the index test results interpreted without knowledge of the reference standard?', YN), q('2.2', 'If a threshold was used, was it pre-specified?', YN)] },
      { key: 'D3', name: 'Reference standard', questions: [q('3.1', 'Is the reference standard likely to correctly classify the target condition?', YN), q('3.2', 'Were the reference standard results interpreted without knowledge of the index test?', YN)] },
      { key: 'D4', name: 'Flow and timing', questions: [q('4.1', 'Was there an appropriate interval between index test and reference standard?', YN), q('4.2', 'Did all patients receive the same reference standard?', YN), q('4.3', 'Were all patients included in the analysis?', YN)] },
    ],
    levels: ['low', 'unclear', 'high'],
    otherLevels: [],
    robvis: { tool: 'QUADAS-2', labels: { low: 'Low', unclear: 'Unclear', high: 'High' } },
    worstDomainOverall: true,
  },
  newcastle_ottawa: {
    tool: 'newcastle_ottawa',
    version: 'cohort',
    name: 'Newcastle-Ottawa Scale (cohort studies)',
    domains: [
      { key: 'D1', name: 'Selection', questions: [q('S1', 'Representativeness of the exposed cohort', ['star', 'no_star']), q('S2', 'Selection of the non-exposed cohort', ['star', 'no_star']), q('S3', 'Ascertainment of exposure', ['star', 'no_star']), q('S4', 'Outcome not present at start of study', ['star', 'no_star'])] },
      { key: 'D2', name: 'Comparability', questions: [q('C1', 'Comparability of cohorts on the basis of the design or analysis', ['two_stars', 'star', 'no_star'])] },
      { key: 'D3', name: 'Outcome', questions: [q('O1', 'Assessment of outcome', ['star', 'no_star']), q('O2', 'Was follow-up long enough for outcomes to occur?', ['star', 'no_star']), q('O3', 'Adequacy of follow-up of cohorts', ['star', 'no_star'])] },
    ],
    levels: ['low', 'moderate', 'high'],
    otherLevels: ['no_information'],
    robvis: { tool: 'Generic', labels: { low: 'Low', moderate: 'Some concerns', high: 'High', no_information: 'No information' } },
    worstDomainOverall: false,
  },
};

/** The overall judgement the instrument's rule proposes from the domain judgements, or null. */
export const proposeOverall = (instrument: RobInstrument, domainJudgements: Record<string, { judgement: string }>): string | null => {
  if (!instrument.worstDomainOverall) return null;
  const judgements = instrument.domains.map((domain) => domainJudgements[domain.key]?.judgement);
  if (judgements.some((judgement) => judgement === undefined)) return null;
  const ranked = judgements.map((judgement) => instrument.levels.indexOf(judgement!)).filter((rank) => rank >= 0);
  const unranked = judgements.length - ranked.length;
  if (unranked > 0 && judgements.some((judgement) => judgement !== 'no_information' && !instrument.levels.includes(judgement!))) return null;
  const worst = ranked.length === 0 ? -1 : Math.max(...ranked);
  // "No information" weighs only when no ranked domain is already at the worst level.
  if (unranked > 0 && worst < instrument.levels.length - 1) return 'no_information';
  return worst < 0 ? null : instrument.levels[worst]!;
};
