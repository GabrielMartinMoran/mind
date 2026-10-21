// Synthetic LoCoMo-shaped fixture created for our own tests only.
//
// This is NOT LoCoMo content: it is a tiny, invented conversation used to test
// subset selection, ingestion and metrics without downloading or vendoring the
// real (CC BY-NC 4.0) dataset. It mirrors the dataset schema: `speaker_a/b`,
// `session_<n>` turn arrays, `session_<n>_date_time` strings and QA items with
// `question`/`answer` (or `adversarial_answer`)/`evidence`/`category`.

import type { LocomoConversation, LocomoQaItem, LocomoSample } from '../../src/locomo/types';

export const SYNTHETIC_SAMPLE_ID = 'conv-syn';
export const SYNTHETIC_PER_CATEGORY = 8;

const SPEAKER_A = 'Ada';
const SPEAKER_B = 'Bob';

interface SyntheticSession {
  readonly dateTime: string;
  readonly turns: readonly { readonly speaker: string; readonly text: string }[];
}

const SESSIONS: readonly SyntheticSession[] = [
  {
    dateTime: '10:00 am on 1 Jan, 2024',
    turns: [
      { speaker: SPEAKER_A, text: 'I adopted a golden retriever puppy named Rex.' },
      { speaker: SPEAKER_B, text: 'That is wonderful, dogs are great companions.' },
      { speaker: SPEAKER_A, text: 'Rex loves to chase tennis balls in the park.' },
    ],
  },
  {
    dateTime: '11:00 am on 2 Feb, 2024',
    turns: [
      { speaker: SPEAKER_B, text: 'I started learning to play the cello last month.' },
      { speaker: SPEAKER_A, text: 'Music is a beautiful hobby, keep practicing.' },
      { speaker: SPEAKER_B, text: 'My cello teacher says I improve quickly.' },
    ],
  },
  {
    dateTime: '9:00 am on 3 Mar, 2024',
    turns: [
      { speaker: SPEAKER_A, text: 'I traveled to Kyoto and visited ancient temples.' },
      { speaker: SPEAKER_B, text: 'Kyoto sounds peaceful, I want to visit someday.' },
      { speaker: SPEAKER_A, text: 'The cherry blossoms in Kyoto were stunning.' },
    ],
  },
];

export function syntheticConversation(): LocomoConversation {
  const conversation: LocomoConversation = { speaker_a: SPEAKER_A, speaker_b: SPEAKER_B };
  SESSIONS.forEach((session, sessionIndex) => {
    const n = sessionIndex + 1;
    conversation[`session_${n}_date_time`] = session.dateTime;
    conversation[`session_${n}`] = session.turns.map((turn, turnIndex) => ({
      speaker: turn.speaker,
      dia_id: `D${n}:${turnIndex + 1}`,
      text: turn.text,
    }));
  });
  return conversation;
}

/** Expected `dia_id` -> content map, in session/turn order. */
export function syntheticTurnContents(): { diaId: string; content: string }[] {
  const rows: { diaId: string; content: string }[] = [];
  SESSIONS.forEach((session, sessionIndex) => {
    const n = sessionIndex + 1;
    session.turns.forEach((turn, turnIndex) => {
      rows.push({
        diaId: `D${n}:${turnIndex + 1}`,
        content: `[${session.dateTime}] ${turn.speaker}: ${turn.text}`,
      });
    });
  });
  return rows;
}

function qaForCategory(category: number, index: number): LocomoQaItem {
  const evidence = [`D${(index % 3) + 1}:1`];
  const question = `Synthetic category ${category} question ${index}: what did Ada say?`;
  if (category === 5) {
    return { question, evidence, category, adversarial_answer: `adversarial answer ${index}` };
  }
  return { question, answer: `answer ${category}-${index}`, evidence, category };
}

export function syntheticDataset(): LocomoSample[] {
  const qa: LocomoQaItem[] = [];
  for (const category of [1, 2, 3, 4, 5]) {
    for (let i = 0; i < SYNTHETIC_PER_CATEGORY; i++) qa.push(qaForCategory(category, i));
  }
  // A dataset-like empty-evidence open-domain question (metrics are N/A).
  qa.push({
    question: 'Synthetic empty-evidence question?',
    answer: 'unknown',
    evidence: [],
    category: 3,
  });
  return [{ sample_id: SYNTHETIC_SAMPLE_ID, conversation: syntheticConversation(), qa }];
}
