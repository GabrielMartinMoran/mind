// Minimal command-line entry point (fixture). Persistence is not implemented.

import { TaskStore } from './tasks.ts';

const [, , command, ...rest] = process.argv;
const store = new TaskStore();

if (command === 'add') {
  const task = store.add(rest.join(' '));
  console.log(`added ${task.id}: ${task.title}`);
} else {
  for (const task of store.list()) {
    console.log(`${task.id} ${task.done ? 'x' : ' '} ${task.title}`);
  }
}
