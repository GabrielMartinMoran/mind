// Minimal command-line entry point (fixture). The `export` command does not
// exist yet — that is the gap the benchmark exercises.

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
