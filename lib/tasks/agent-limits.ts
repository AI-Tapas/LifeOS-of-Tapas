// B26. Length limits for agent instructions and results, in a file with no
// imports so the browser bundle can use them (agent-instructions.ts hashes,
// and needs node:crypto). The migration's check constraints say the same.
export const INSTRUCTION_MAX = 2000;
export const RESULT_MAX = 4000;
