import { afterEach, describe, expect, test } from 'bun:test';

import { escapeHtml, sanitizeHtml } from '../src/domain/sanitize.js';

import { installDom, type DomHarness } from './helpers/dom.js';

let harness: DomHarness | null = null;

afterEach(() => {
  harness?.cleanup();
  harness = null;
});

function sanitizedDocument(html: string): { output: string; document: HTMLElement } {
  harness = installDom();
  const output = sanitizeHtml(html, { document: harness.document });
  const container = harness.document.createElement('div');
  container.innerHTML = output;
  return { output, document: container as unknown as HTMLElement };
}

describe('sanitizeHtml dangerous content', () => {
  test('removes script elements and their content', () => {
    const { output } = sanitizedDocument('<p>safe</p><script>alert(1)</script>');
    expect(output).toBe('<p>safe</p>');
  });

  test('removes event handler and style attributes', () => {
    const { output } = sanitizedDocument('<p onclick="alert(1)" style="color:red">hello</p>');
    expect(output).toBe('<p>hello</p>');
  });

  test('removes html comments', () => {
    const { output } = sanitizedDocument('<p>a</p><!-- secret --><p>b</p>');
    expect(output).toBe('<p>a</p><p>b</p>');
  });

  test('removes form controls and embedded content', () => {
    const { output } = sanitizedDocument(
      '<p>keep</p><iframe src="https://evil.test"></iframe><form><input value="x"></form>'
    );
    expect(output).toBe('<p>keep</p>');
  });
});

describe('sanitizeHtml links', () => {
  test('retains http, https, and mailto links and adds rel to external links', () => {
    const { document } = sanitizedDocument(
      '<a href="https://example.test/a">https</a><a href="http://example.test">http</a><a href="mailto:me@example.test">mail</a>'
    );
    const links = document.querySelectorAll('a');

    expect(links).toHaveLength(3);
    expect(links[0]?.getAttribute('href')).toBe('https://example.test/a');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[1]?.getAttribute('href')).toBe('http://example.test');
    expect(links[1]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[2]?.getAttribute('href')).toBe('mailto:me@example.test');
    expect(links[2]?.hasAttribute('rel')).toBe(false);
  });

  test('removes javascript, data, and vbscript hrefs while preserving text', () => {
    const { document } = sanitizedDocument(
      '<a href="javascript:alert(1)">js</a><a href="data:text/html,hi">data</a><a href="vbscript:msgbox(1)">vb</a>'
    );
    const links = document.querySelectorAll('a');

    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(link.hasAttribute('href')).toBe(false);
    }
    expect(document.textContent).toContain('js');
  });

  test('removes obfuscated javascript hrefs', () => {
    const { document } = sanitizedDocument(
      '<a href="java&#x0A;script:alert(1)">x</a><a href="  JaVaScRiPt:alert(1)">y</a>'
    );
    for (const link of document.querySelectorAll('a')) {
      expect(link.hasAttribute('href')).toBe(false);
    }
  });

  test('preserves safe fragment and relative links', () => {
    const { document } = sanitizedDocument(
      '<a href="#section">fragment</a><a href="/spaces/foo">root</a><a href="foo/bar">relative</a>'
    );
    const links = document.querySelectorAll('a');

    expect(links).toHaveLength(3);
    expect(links[0]?.getAttribute('href')).toBe('#section');
    expect(links[1]?.getAttribute('href')).toBe('/spaces/foo');
    expect(links[2]?.getAttribute('href')).toBe('foo/bar');
    for (const link of links) {
      expect(link.hasAttribute('rel')).toBe(false);
    }
  });

  test('blocks protocol-relative and backslash-relative hrefs', () => {
    const { document } = sanitizedDocument(
      '<a href="//evil.test">protocol</a><a href="  //evil.test">spaced</a><a href="\\\\evil.test">backslash</a>'
    );
    for (const link of document.querySelectorAll('a')) {
      expect(link.hasAttribute('href')).toBe(false);
    }
  });

  test('blocks slash-backslash hrefs and their entity forms', () => {
    const { document } = sanitizedDocument(
      '<a href="/\\evil.test">slash-backslash</a><a href="/&#92;evil.test">entity</a>'
    );
    const links = document.querySelectorAll('a');
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.hasAttribute('href')).toBe(false);
    }
  });

  test('keeps safe relative and fragment hrefs', () => {
    const { document } = sanitizedDocument(
      '<a href="#section">fragment</a><a href="/spaces/foo">root</a><a href="foo/bar">relative</a>'
    );
    const links = document.querySelectorAll('a');
    expect(links).toHaveLength(3);
    expect(links[0]?.getAttribute('href')).toBe('#section');
    expect(links[1]?.getAttribute('href')).toBe('/spaces/foo');
    expect(links[2]?.getAttribute('href')).toBe('foo/bar');
  });

  test('re-parsing sanitized output leaves no evil.test protocol-relative links', () => {
    harness = installDom();
    const doc = harness.document;
    const output = sanitizeHtml('<a href="/\\evil.test">x</a><a href="//evil.test">y</a>', {
      document: doc,
    });
    const container = doc.createElement('div');
    container.innerHTML = output;
    for (const link of container.querySelectorAll('a')) {
      const href = link.getAttribute('href') ?? '';
      expect(href).not.toContain('evil.test');
    }
  });
});

describe('sanitizeHtml images', () => {
  test('strips images entirely, including safe-looking sources', () => {
    const { output, document } = sanitizedDocument(
      '<p>before</p><img src="https://example.test/a.png" alt="A" title="T"><p>after</p>'
    );

    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(output).toBe('<p>before</p><p>after</p>');
  });

  test('strips images with unsafe or missing schemes', () => {
    const { document } = sanitizedDocument(
      '<img src="data:image/png;base64,abc"><img src="javascript:alert(1)"><img alt="no src">'
    );
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });
});

describe('sanitizeHtml foreign and embedded content', () => {
  test('removes svg, math, template, noscript, and dangerous attributes', () => {
    harness = installDom();
    const doc = harness.document;
    const input = [
      '<svg><a xlink:href="javascript:alert(1)"><text>svg text</text></a></svg>',
      '<math><mi xlink:href="javascript:alert(1)">math text</mi></math>',
      '<template><img src="https://evil.test/x.png" onerror="alert(1)"></template>',
      '<noscript><img src="javascript:alert(1)" onerror="alert(1)"></noscript>',
      '<p><img src="https://example.test/a.png" srcset="javascript:alert(1) 1x" onerror="alert(1)"></p>',
      '<form action="/x"><button formaction="javascript:alert(1)">button</button></form>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    ].join('');

    const output = sanitizeHtml(input, { document: doc });
    const container = doc.createElement('div');
    container.innerHTML = output;

    expect(
      container.querySelector('svg, math, template, noscript, img, iframe, form, button, script')
    ).toBeNull();
    for (const element of container.querySelectorAll('*')) {
      for (const attribute of [
        'xlink:href',
        'srcset',
        'formaction',
        'srcdoc',
        'onerror',
        'onclick',
      ]) {
        expect(element.hasAttribute(attribute)).toBe(false);
      }
    }
    for (const link of container.querySelectorAll('a')) {
      expect((link.getAttribute('href') ?? '').toLowerCase()).not.toContain('javascript:');
    }

    // The sanitized output is stable when parsed and sanitized again.
    expect(sanitizeHtml(output, { document: doc })).toBe(output);
  });
});

describe('sanitizeHtml allowed markup and text', () => {
  test('preserves allowed nested markup', () => {
    const input =
      '<h1>Title</h1><blockquote><p><strong>bold</strong> <em>em</em> <code>x</code></p></blockquote><ul><li>one</li></ul><table><thead><tr><th>H</th></tr></thead><tbody><tr><td>D</td></tr></tbody></table><p><del>d</del><sup>s</sup><sub>b</sub></p>';
    const { output } = sanitizedDocument(input);

    for (const tag of [
      'h1',
      'blockquote',
      'p',
      'strong',
      'em',
      'code',
      'ul',
      'li',
      'table',
      'thead',
      'tr',
      'th',
      'tbody',
      'td',
      'del',
      'sup',
      'sub',
    ]) {
      expect(output).toContain(`<${tag}`);
    }
  });

  test('unwraps unknown tags while keeping their text', () => {
    const { output } = sanitizedDocument('<div><span>inner</span></div>');
    expect(output).toBe('inner');
  });

  test('preserves text content and escapes raw text', () => {
    const { output } = sanitizedDocument('<p>a &amp; b &lt; c</p>');
    expect(output).toBe('<p>a &amp; b &lt; c</p>');
  });
});

describe('escapeHtml', () => {
  test('escapes HTML-significant characters', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    expect(escapeHtml(null)).toBe('');
  });
});
