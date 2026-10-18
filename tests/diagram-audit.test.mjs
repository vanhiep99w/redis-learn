import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectMarkdown, publishedFiles } from '../scripts/audit-diagrams.mjs';

for (const [name, source] of [
  ['diagram', '```diagram\n┌───┐\n│ A │\n└───┘\n```'],
  ['mermaid', '```mermaid\nA --> B\n```'],
  ['unlabelled', '```\n┌───┐\n│ A │\n└───┘\n```'],
  ['text', '```text\nA ──▶ B\n```'],
  ['arbitrary language', '```bash\n┌───┐\n│ A │\n└───┘\n```'],
  ['tilde fence', '~~~diagram\nA -> B\n~~~'],
  ['blockquote', '> ```diagram\n> A -> B\n> ```'],
  ['list nesting', '- Ví dụ\n\n  ```diagram\n  A -> B\n  ```'],
  ['indented code', '    ┌───┐\n    │ A │\n    └───┘'],
]) {
  test(`audit bắt được ${name}, không phụ thuộc nhãn text`, () => {
    const { violations } = inspectMarkdown(source, 'demo.md');
    assert.equal(violations.length, 1);
    assert.equal(violations[0].path, 'demo.md');
    assert.ok(violations[0].line > 0);
  });
}

test('fence D2 và descriptor hiện có không bị nhận nhầm', () => {
  for (const language of ['d2', 'terminal-session', 'code-diff', 'code-walkthrough', 'span-waterfall']) {
    assert.equal(inspectMarkdown('```' + language + '\nsource: value\n```').violations.length, 0);
  }
});

test('literal fence trong code không tạo thêm code block', () => {
  const result = inspectMarkdown('````text\n```diagram\nĐây là literal fence trong mẫu code\n```\n````');
  assert.equal(result.blocks.length, 1);
  assert.equal(result.violations.length, 0);
});

test('payload, công thức và log không phải diagram', () => {
  const result = inspectMarkdown('```text\n*3\n$3\nSET\n$1\na\n$1\n1\n```\n\n```text\nRAM = dataset + overhead\n```');
  assert.equal(result.blocks.length, 2);
  assert.equal(result.violations.length, 0);
});

test('chỉ giữ ASCII nếu có lý do ngay trước fence', () => {
  const source = '<!-- diagram-text: Tách literal Stream ID theo vị trí ký tự. -->\n\n```text\n1783400000123-1\n└────┬──────┘└┬┘\n```';
  const result = inspectMarkdown(source);
  assert.equal(result.violations.length, 0);
  assert.match(result.blocks[0].reason, /literal Stream ID/);
  assert.equal(inspectMarkdown(source.replace('\n\n```', '\n\nĐoạn khác.\n\n```')).violations.length, 1);
});

test('không dùng lý do keep-text để che fence diagram cũ', () => {
  const result = inspectMarkdown('<!-- diagram-text: Một lý do. -->\n\n```diagram\nA -> B\n```');
  assert.equal(result.violations.length, 1);
});

test('README là source of truth cho các file được audit', () => {
  const files = publishedFiles('- [x] [RDB](rdb.md) - Snapshot\n- [ ] [Draft](draft.md) - Pending\n- [x] [AOF](aof.md) - Log');
  assert.deepEqual(files, ['rdb.md', 'aof.md']);
});
