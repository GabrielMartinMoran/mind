import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { renderFormErrors, validateMemoryForm, validateSpaceForm } from '../src/views/forms.js';
import { createModal } from '../src/views/modal.js';

import { installDom, type DomHarness } from './helpers/dom';

const indexHtmlPath = join(import.meta.dir, '../public/index.html');

type ModalKind = 'modal-new-space' | 'modal-new-memory';

interface ModalFixture {
  dom: DomHarness;
  dialog: HTMLDialogElement;
  form: HTMLElement;
  trigger: HTMLButtonElement;
  modal: ReturnType<typeof createModal>;
}

function setup(kind: ModalKind): ModalFixture {
  const dom = installDom();
  const html = readFileSync(indexHtmlPath, 'utf8');
  const parsed = new dom.window.DOMParser().parseFromString(html, 'text/html');
  const source = parsed.getElementById(kind);
  if (!source) throw new Error(`${kind} markup missing from index.html`);

  const dialog = dom.document.importNode(source as never, true) as unknown as HTMLDialogElement;
  dom.document.body.replaceChildren(dialog);

  const trigger = dom.document.createElement('button');
  trigger.id = 'trigger';
  trigger.textContent = 'Open';
  dom.document.body.appendChild(trigger);
  trigger.focus();

  const form = dialog.querySelector<HTMLElement>('[data-modal-form]');
  if (!form) throw new Error(`${kind} is missing [data-modal-form]`);

  const modal = createModal({ dialog, document: dom.document });

  return { dom, dialog, form, trigger, modal };
}

function click(dom: DomHarness, target: EventTarget): void {
  target.dispatchEvent(
    new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    } as never) as never
  );
}

function pressEscape(dom: DomHarness): void {
  dom.document.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    } as never) as never
  );
}

function fireCancel(dom: DomHarness, dialog: HTMLDialogElement): void {
  dialog.dispatchEvent(new dom.window.Event('cancel', { cancelable: true }) as never);
}

function byId<T extends Element>(root: ParentNode, id: string): T {
  const node = root.querySelector<T>(`#${id}`);
  if (!node) throw new Error(`#${id} not found`);
  return node;
}

describe('modal markup', () => {
  test('index.html declares closed native dialogs with an accessible name and error region', () => {
    const kinds: ModalKind[] = ['modal-new-space', 'modal-new-memory'];

    for (const kind of kinds) {
      const dom = installDom();
      try {
        const html = readFileSync(indexHtmlPath, 'utf8');
        const parsed = new dom.window.DOMParser().parseFromString(html, 'text/html');
        const dialog = parsed.getElementById(kind);

        expect(dialog?.tagName, `${kind} should be a <dialog>`).toBe('DIALOG');
        expect(dialog?.hasAttribute('open'), `${kind} should start closed`).toBe(false);
        expect(
          dialog?.getAttribute('aria-labelledby'),
          `${kind} needs aria-labelledby`
        ).toBeTruthy();
        expect(
          dialog?.querySelector('[data-modal-error][role="alert"]'),
          `${kind} needs an alert error region`
        ).not.toBeNull();
        expect(
          dialog?.querySelector('[data-modal-form]'),
          `${kind} needs a form container`
        ).not.toBeNull();
      } finally {
        dom.cleanup();
      }
    }
  });
});

describe('modal dialog icons', () => {
  test('every dialog action keeps its label and adds a decorative local sprite icon', () => {
    const dom = installDom();
    try {
      const html = readFileSync(indexHtmlPath, 'utf8');
      const parsed = new dom.window.DOMParser().parseFromString(html, 'text/html');

      const expectations: Array<[string, string, string]> = [
        ['modal-space-cancel', 'x', 'Cancel'],
        ['modal-space-create', 'check', 'Create'],
        ['modal-mem-cancel', 'x', 'Cancel'],
        ['modal-mem-create', 'check', 'Add'],
        ['modal-delete-cancel', 'x', 'Cancel'],
        ['modal-delete-confirm', 'trash-2', 'Delete'],
      ];

      for (const [id, icon, label] of expectations) {
        const button = parsed.getElementById(id);
        expect(button, `#${id} should exist`).not.toBeNull();
        expect(button?.textContent?.trim(), `#${id} keeps its visible label`).toBe(label);

        const svg = button?.querySelector('svg');
        expect(svg?.querySelector('use')?.getAttribute('href'), `#${id} icon`).toBe(
          `/assets/icons.svg#icon-${icon}`
        );
        expect(svg?.getAttribute('aria-hidden'), `#${id} decorative icon`).toBe('true');
        expect(svg?.getAttribute('focusable'), `#${id} icon not focusable`).toBe('false');
      }
    } finally {
      dom.cleanup();
    }
  });
});

describe('modal dialog behavior', () => {
  test('open shows the dialog and focuses the first field', () => {
    const { dom, dialog, trigger, modal } = setup('modal-new-space');
    try {
      modal.open({ trigger });

      expect(dialog.open).toBe(true);
      expect(modal.isOpen()).toBe(true);
      expect(dom.document.activeElement).toBe(byId(dialog, 'new-space-name'));
    } finally {
      dom.cleanup();
    }
  });

  test('close hides the dialog and returns focus to the trigger', () => {
    const { dom, dialog, trigger, modal } = setup('modal-new-space');
    try {
      modal.open({ trigger });
      expect(dom.document.activeElement).not.toBe(trigger);

      modal.close();

      expect(dialog.open).toBe(false);
      expect(modal.isOpen()).toBe(false);
      expect(dom.document.activeElement).toBe(trigger);
    } finally {
      dom.cleanup();
    }
  });

  test('Escape closes the dialog and returns focus to the trigger', () => {
    const { dom, dialog, trigger, modal } = setup('modal-new-space');
    try {
      modal.open({ trigger });

      pressEscape(dom);

      expect(dialog.open).toBe(false);
      expect(dom.document.activeElement).toBe(trigger);
    } finally {
      dom.cleanup();
    }
  });

  test('the native cancel event closes the dialog', () => {
    const { dom, dialog, trigger, modal } = setup('modal-new-memory');
    try {
      modal.open({ trigger });

      fireCancel(dom, dialog);

      expect(dialog.open).toBe(false);
      expect(dom.document.activeElement).toBe(trigger);
    } finally {
      dom.cleanup();
    }
  });

  test('clicking the backdrop closes the dialog', () => {
    const { dom, dialog, trigger, modal } = setup('modal-new-memory');
    try {
      modal.open({ trigger });

      click(dom, dialog);

      expect(dialog.open).toBe(false);
      expect(dom.document.activeElement).toBe(trigger);
    } finally {
      dom.cleanup();
    }
  });

  test('a dialog can be reopened after Escape', () => {
    const { dom, dialog, trigger, modal } = setup('modal-new-space');
    try {
      modal.open({ trigger });
      pressEscape(dom);
      expect(dialog.open).toBe(false);

      modal.open({ trigger });

      expect(dialog.open).toBe(true);
      expect(modal.isOpen()).toBe(true);
      expect(dom.document.activeElement).toBe(byId(dialog, 'new-space-name'));
    } finally {
      dom.cleanup();
    }
  });
});

describe('modal error region', () => {
  test('setError announces the message and preserves entered values', () => {
    const { dom, dialog, trigger, modal } = setup('modal-new-memory');
    try {
      modal.open({ trigger });
      const name = byId<HTMLInputElement>(dialog, 'new-mem-name');
      name.value = 'keep-me';

      modal.setError('Could not save the memory.');

      const errorRegion = dialog.querySelector<HTMLElement>('[data-modal-error]');
      expect(errorRegion).not.toBeNull();
      expect(errorRegion!.getAttribute('role')).toBe('alert');
      expect(errorRegion!.hasAttribute('hidden')).toBe(false);
      expect(errorRegion!.textContent).toBe('Could not save the memory.');
      expect(name.value).toBe('keep-me');

      modal.clearError();

      expect(errorRegion!.hasAttribute('hidden')).toBe(true);
      expect(errorRegion!.textContent).toBe('');
    } finally {
      dom.cleanup();
    }
  });

  test('opening again resets a previous error', () => {
    const { dom, dialog, trigger, modal } = setup('modal-new-space');
    try {
      modal.open({ trigger });
      modal.setError('boom');
      modal.close();

      modal.open({ trigger });

      const errorRegion = dialog.querySelector<HTMLElement>('[data-modal-error]');
      expect(errorRegion!.hasAttribute('hidden')).toBe(true);
      expect(errorRegion!.textContent).toBe('');
    } finally {
      dom.cleanup();
    }
  });
});

describe('modal teardown', () => {
  test('destroy removes listeners and is idempotent', () => {
    const { dom, dialog, trigger, modal } = setup('modal-new-space');
    try {
      modal.open({ trigger });

      modal.destroy();
      modal.destroy();

      pressEscape(dom);
      click(dom, dialog);

      expect(dialog.open).toBe(true);
    } finally {
      dom.cleanup();
    }
  });
});

describe('form validation', () => {
  test('validateSpaceForm requires a non-empty trimmed name', () => {
    expect(validateSpaceForm({ name: '   ' })).toEqual({ name: expect.any(String) });
    expect(validateSpaceForm({ name: 'my-space' })).toEqual({});
  });

  test('validateMemoryForm requires name and content and a valid tier', () => {
    expect(validateMemoryForm({ name: '', content: '', tier: 2 })).toEqual({
      name: expect.any(String),
      content: expect.any(String),
    });
    expect(validateMemoryForm({ name: 'm', content: 'c', tier: 9 })).toEqual({
      tier: expect.any(String),
    });
    expect(validateMemoryForm({ name: 'm', content: 'c', tier: 3 })).toEqual({});
  });

  test('renderFormErrors links inline errors with aria-invalid and aria-describedby', () => {
    const { dom, form } = setup('modal-new-memory');
    try {
      const name = byId<HTMLInputElement>(form, 'new-mem-name');
      const content = byId<HTMLTextAreaElement>(form, 'new-mem-content');

      const invalid = renderFormErrors(
        form,
        validateMemoryForm({ name: '', content: '', tier: 2 })
      );
      expect(invalid).toBe(false);

      expect(name.getAttribute('aria-invalid')).toBe('true');
      expect(content.getAttribute('aria-invalid')).toBe('true');

      const nameDescribedBy = name.getAttribute('aria-describedby');
      expect(nameDescribedBy).toBeTruthy();
      const nameError = form.querySelector<HTMLElement>(`#${nameDescribedBy}`);
      expect(nameError?.textContent).toBeTruthy();
      expect(nameError?.hasAttribute('hidden')).toBe(false);

      const valid = renderFormErrors(
        form,
        validateMemoryForm({ name: 'n', content: 'c', tier: 2 })
      );
      expect(valid).toBe(true);
      expect(name.hasAttribute('aria-invalid')).toBe(false);
      expect(content.hasAttribute('aria-invalid')).toBe(false);
    } finally {
      dom.cleanup();
    }
  });
});
