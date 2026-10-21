// Tiny in-memory task store (fixture).

export interface Task {
  id: string;
  title: string;
  done: boolean;
  createdAt: string;
}

export class TaskStore {
  private readonly tasks: Task[] = [];
  private nextId = 1;

  add(title: string): Task {
    const task: Task = {
      id: String(this.nextId++),
      title,
      done: false,
      createdAt: new Date().toISOString(),
    };
    this.tasks.push(task);
    return task;
  }

  complete(id: string): boolean {
    const task = this.tasks.find(entry => entry.id === id);
    if (!task) return false;
    task.done = true;
    return true;
  }

  list(): readonly Task[] {
    return this.tasks;
  }
}
