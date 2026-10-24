import { renderSystemInstructions } from '../../../cli/system-instructions';

const FULL_INSTRUCTIONS = renderSystemInstructions();

export async function getSystemInstructionsHandler() {
  return {
    content: [{ type: 'text', text: FULL_INSTRUCTIONS }],
    instructions_version: '2.2.0',
  };
}
