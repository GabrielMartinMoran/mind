// Minimal command-line entry point (fixture).

import { DATABASE_PATH, type Task } from './tasks.ts';

const tasks: Task[] = [];

for (const task of tasks) {
  console.log(`${task.id} ${task.done ? 'x' : ' '} ${task.title}`);
}

if (tasks.length === 0) console.log(`no tasks (store: ${DATABASE_PATH})`);
