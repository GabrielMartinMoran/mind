// Task queue model (fixture).
//
// Current storage decision: every task is written to a single SQLite database
// at `data/tasks.db` through `bun:sqlite`.

export interface Task {
  id: string;
  title: string;
  done: boolean;
}

export const DATABASE_PATH = 'data/tasks.db';
