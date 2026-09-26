import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toolRegistry } from '../server.js';

describe('tool registry validity', () => {
  const tools = toolRegistry();

  it('exposes a curated core profile (>= 30 tools)', () => {
    assert.ok(tools.length >= 30, `expected >= 30 tools, got ${tools.length}`);
  });

  it('every tool has a unique non-empty name', () => {
    const names = tools.map((t) => t.name);
    assert.ok(names.every((n) => typeof n === 'string' && n.length > 0));
    assert.equal(new Set(names).size, names.length, 'duplicate tool names');
  });

  it('every tool has title, description, and input schema', () => {
    for (const t of tools) {
      assert.ok(t.title && t.title.length > 0, `${t.name}: missing title`);
      assert.ok(t.description && t.description.length >= 20, `${t.name}: description too short`);
      assert.ok(t.inputSchema, `${t.name}: missing inputSchema`);
    }
  });

  it('every tool has all four annotations as booleans', () => {
    for (const t of tools) {
      for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
        assert.equal(typeof t.annotations[key], 'boolean', `${t.name}: annotations.${key}`);
      }
    }
  });

  it('read-only tools never claim destructive', () => {
    for (const t of tools) {
      if (t.annotations.readOnlyHint) {
        assert.equal(t.annotations.destructiveHint, false, `${t.name}`);
      }
    }
  });

  it('includes the key workflow tools', () => {
    const names = new Set(tools.map((t) => t.name));
    for (const required of [
      'verify_premiere_connection',
      'probe_modal_dialog',
      'create_project',
      'import_media',
      'import_media_from_url',
      'add_to_timeline',
      'export_sequence',
      'execute_extendscript',
      'search_tools',
      'ae_verify_connection',
      'ae_create_composition',
      'ae_import_media_from_url',
      'ae_render_comp',
    ]) {
      assert.ok(names.has(required), `missing required tool: ${required}`);
    }
  });
});
