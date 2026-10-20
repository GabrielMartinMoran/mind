// Benchmark B scenario registry.
//
// Scenarios are module constants: their prompts are byte-identical across every
// condition, and every scenario carries its own deterministic `makeAssertion`.

import type { Scenario } from '../scenario';

import { B1_SCENARIO } from './b1/index';
import { B10_SCENARIO } from './b10/index';
import { B4_SCENARIO } from './b4/index';
import { B5_SCENARIO } from './b5/index';
import { B6_SCENARIO } from './b6/index';
import { B7_SCENARIO } from './b7/index';
import { B8_SCENARIO } from './b8/index';
import { B9_SCENARIO } from './b9/index';

export const SCENARIOS: readonly Scenario[] = [
  B1_SCENARIO,
  B4_SCENARIO,
  B5_SCENARIO,
  B6_SCENARIO,
  B7_SCENARIO,
  B9_SCENARIO,
  B8_SCENARIO,
  B10_SCENARIO,
];

export const SCENARIO_IDS: readonly string[] = SCENARIOS.map(scenario => scenario.id);

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find(scenario => scenario.id === id);
}

/** Select the requested scenarios, preserving registry order; unknown ids throw. */
export function selectScenarios(ids?: readonly string[]): Scenario[] {
  if (!ids || ids.length === 0) return [...SCENARIOS];
  const wanted = new Set(ids);
  for (const id of wanted) {
    if (!scenarioById(id)) throw new Error(`unknown scenario: ${id}`);
  }
  return SCENARIOS.filter(scenario => wanted.has(scenario.id));
}
