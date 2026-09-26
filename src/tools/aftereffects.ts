/**
 * Curated After Effects tool profile.
 *
 * Talks to the "MCP Bridge Auto" ScriptUI panel through the file protocol in
 * src/bridge/aeBridge.ts (adapted from Dakkshin/after-effects-mcp, MIT — see
 * THIRD-PARTY-NOTICES.md). The panel polls for commands roughly every 2s, so
 * each call takes a few seconds; render jobs go through aerender.exe instead.
 *
 * Conventions:
 * - Compositions are referenced by name (compName) or 1-based index (compIndex).
 * - Layers are referenced by name or 1-based index within their comp.
 * - Colors are 0-1 float triples, e.g. [1, 0, 0] for red.
 * - Time is in SECONDS.
 */
import { execFile } from 'node:child_process';
import * as z from 'zod/v4';
import { AeBridge } from '../bridge/aeBridge.js';
import { downloadToAssets } from './download.js';
import type { ToolAnnotations, ToolContext, ToolDef } from './premiere.js';

export interface AeToolContext {
  ae: AeBridge;
  assetsDir: string;
  caller: string;
}

const RO: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const color3 = z.array(z.number().min(0).max(1)).length(3).describe('RGB color as 0-1 floats, e.g. [1,0,0]');
const pos2 = z.array(z.number()).length(2).describe('[x, y] in comp pixels');
const pos3 = z.array(z.number()).length(3).describe('[x, y, z] in comp pixels');

async function aeRun(ctx: AeToolContext, command: string, args: Record<string, unknown> = {}, timeoutMs = 90000) {
  return ctx.ae.runCommand(command, args, timeoutMs);
}

export function buildAeTools(): ToolDef[] {
  const tools: ToolDef[] = [];
  const add = (def: ToolDef) => {
    tools.push(def);
    return def;
  };
  const run = (name: string, title: string, description: string, inputSchema: z.ZodTypeAny, annotations: ToolAnnotations,
    fn: (args: any, ctx: AeToolContext) => Promise<unknown>) =>
    add({ name, title, description, inputSchema, annotations, run: fn as unknown as (args: any, ctx: ToolContext) => Promise<unknown> });

  // --- connection ---------------------------------------------------------
  run('ae_verify_connection', 'Verify AE connection', 'Check that After Effects is running and the MCP Bridge Auto panel responds. Launches AE if it is down and launch=true.', z.object({ launch: z.boolean().default(false).describe('Launch After Effects if it is not running') }), RO,
    async (args, ctx) => {
      const info = await ctx.ae.hostInfo();
      let launched = false;
      if (!info.processRunning && args.launch) {
        const r = await ctx.ae.launchIfDown();
        launched = r.launched;
      }
      let probe: unknown = null;
      let probeError: string | null = null;
      try {
        const r = await aeRun(ctx, 'getProjectInfo', {}, 30000);
        probe = r.result;
      } catch (e) {
        probeError = e instanceof Error ? e.message : String(e);
      }
      return {
        processRunning: info.processRunning || launched,
        launched,
        installDir: info.installDir,
        panelResponding: probeError === null,
        probeError,
        project: probe,
      };
    });

  run('ae_get_project_info', 'Get AE project info', 'Project name, path, item counts and first items.', z.object({}), RO,
    async (_a, ctx) => aeRun(ctx, 'getProjectInfo'));

  run('ae_list_compositions', 'List compositions', 'List all compositions in the project.', z.object({}), RO,
    async (_a, ctx) => aeRun(ctx, 'listCompositions'));

  run('ae_get_layer_info', 'Get layer info', 'Layer details for the active composition.', z.object({}), RO,
    async (_a, ctx) => aeRun(ctx, 'getLayerInfo'));

  // --- composition --------------------------------------------------------
  run('ae_create_composition', 'Create composition', 'Create a new composition.', z.object({
    name: z.string().default('New Composition'),
    width: z.number().int().positive().default(1920),
    height: z.number().int().positive().default(1080),
    frameRate: z.number().positive().default(30),
    duration: z.number().positive().default(10).describe('Duration in seconds'),
    backgroundColor: z.object({ r: z.number(), g: z.number(), b: z.number() }).optional().describe('0-255 RGB'),
  }), WRITE, async (args, ctx) => aeRun(ctx, 'createComposition', args));

  run('ae_set_comp_properties', 'Set composition properties', 'Change width/height/frameRate/duration of a composition.', z.object({
    compName: z.string().describe('Composition name'),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    frameRate: z.number().positive().optional(),
    duration: z.number().positive().optional().describe('Seconds'),
  }), WRITE, async (args, ctx) => aeRun(ctx, 'setCompositionProperties', args));

  // --- layers ---------------------------------------------------------------
  run('ae_create_text_layer', 'Create text layer', 'Add a text layer to a composition.', z.object({
    compName: z.string().describe('Target composition name (empty = active)'),
    text: z.string().default('Text Layer'),
    position: pos2.optional(),
    fontSize: z.number().positive().optional(),
    color: color3.optional(),
    startTime: z.number().min(0).optional(),
    duration: z.number().positive().optional(),
  }), WRITE, async (args, ctx) => aeRun(ctx, 'createTextLayer', args));

  run('ae_create_shape_layer', 'Create shape layer', 'Add a rectangle/ellipse shape layer.', z.object({
    compName: z.string().describe('Target composition name'),
    shapeType: z.enum(['rectangle', 'ellipse']).default('rectangle'),
    position: pos2.optional(),
    size: z.array(z.number()).length(2).optional(),
    fillColor: color3.optional(),
    strokeColor: color3.optional(),
    strokeWidth: z.number().min(0).optional(),
  }), WRITE, async (args, ctx) => aeRun(ctx, 'createShapeLayer', args));

  run('ae_create_solid_layer', 'Create solid layer', 'Add a solid color layer.', z.object({
    compName: z.string().describe('Target composition name'),
    name: z.string().default('Solid Layer'),
    color: color3.optional(),
    position: pos2.optional(),
    size: z.array(z.number()).length(2).optional(),
    startTime: z.number().min(0).optional(),
    duration: z.number().positive().optional(),
  }), WRITE, async (args, ctx) => aeRun(ctx, 'createSolidLayer', args));

  run('ae_create_camera', 'Create camera', 'Add a camera layer to a composition.', z.object({
    compName: z.string().describe('Target composition name'),
    name: z.string().default('Camera'),
    zoom: z.number().positive().optional(),
    position: pos3.optional(),
    pointOfInterest: pos3.optional(),
    oneNode: z.boolean().default(false),
  }), WRITE, async (args, ctx) => aeRun(ctx, 'createCamera', args));

  run('ae_set_layer_properties', 'Set layer properties', 'Set position/scale/rotation/opacity (+ text fields) on one layer.', z.object({
    compName: z.string().describe('Composition name'),
    layerName: z.string().optional(),
    layerIndex: z.number().int().positive().optional(),
    position: z.array(z.number()).min(2).max(3).optional(),
    scale: z.array(z.number()).min(2).max(3).optional(),
    rotation: z.number().optional(),
    opacity: z.number().min(0).max(100).optional(),
    text: z.string().optional(),
    fontSize: z.number().positive().optional(),
    fontFamily: z.string().optional(),
    fillColor: color3.optional(),
    startTime: z.number().min(0).optional(),
    duration: z.number().positive().optional(),
  }), WRITE, async (args, ctx) => aeRun(ctx, 'setLayerProperties', args));

  run('ae_batch_set_layer_properties', 'Batch set layer properties', 'Apply property operations to many layers at once.', z.object({
    compName: z.string().describe('Composition name'),
    operations: z.array(z.record(z.string(), z.unknown())).describe('Array of {layerIndex, position?, scale?, rotation?, opacity?, ...}'),
  }), WRITE, async (args, ctx) => aeRun(ctx, 'batchSetLayerProperties', args));

  run('ae_duplicate_layer', 'Duplicate layer', 'Duplicate a layer in a composition.', z.object({
    compName: z.string().describe('Composition name'),
    layerIndex: z.number().int().positive().describe('1-based layer index'),
  }), WRITE, async (args, ctx) => aeRun(ctx, 'duplicateLayer', args));

  run('ae_delete_layer', 'Delete layer', 'Delete a layer from a composition.', z.object({
    compName: z.string().describe('Composition name'),
    layerIndex: z.number().int().positive().describe('1-based layer index'),
  }), DESTRUCTIVE, async (args, ctx) => aeRun(ctx, 'deleteLayer', args));

  // --- animation ------------------------------------------------------------
  run('ae_set_keyframe', 'Set keyframe', 'Set a keyframe for a layer property at a time.', z.object({
    compIndex: z.number().int().positive().describe('1-based composition index'),
    layerIndex: z.number().int().positive().describe('1-based layer index'),
    propertyName: z.string().describe('Property match name, e.g. "ADBE Transform-Group/ADBE Position"'),
    timeInSeconds: z.number().min(0),
    value: z.unknown().describe('Keyframe value (number, [x,y], etc.)'),
  }), WRITE, async (args, ctx) => aeRun(ctx, 'setLayerKeyframe', args));

  run('ae_set_expression', 'Set expression', 'Set or remove an expression on a layer property.', z.object({
    compIndex: z.number().int().positive(),
    layerIndex: z.number().int().positive(),
    propertyName: z.string(),
    expressionString: z.string().describe('Expression code; empty string removes it'),
  }), WRITE, async (args, ctx) => aeRun(ctx, 'setLayerExpression', args));

  // --- effects --------------------------------------------------------------
  run('ae_apply_effect', 'Apply effect', 'Apply an effect to a layer.', z.object({
    compIndex: z.number().int().positive().default(1),
    layerIndex: z.number().int().positive().default(1),
    effectName: z.string().optional().describe('Display name, e.g. "Gaussian Blur"'),
    effectMatchName: z.string().optional().describe('Internal match name, e.g. "ADBE Gaussian Blur 2" (more reliable)'),
    effectSettings: z.record(z.string(), z.unknown()).optional().describe('Effect parameter values'),
  }), WRITE, async (args, ctx) => aeRun(ctx, 'applyEffect', args));

  run('ae_apply_effect_template', 'Apply effect template', 'Apply a predefined effect template to a layer.', z.object({
    compIndex: z.number().int().positive().default(1),
    layerIndex: z.number().int().positive().default(1),
    templateName: z.string(),
    customSettings: z.record(z.string(), z.unknown()).optional(),
  }), WRITE, async (args, ctx) => aeRun(ctx, 'applyEffectTemplate', args));

  // --- footage ----------------------------------------------------------------
  run('ae_import_footage', 'Import footage', 'Import a local file (video/image/audio) into the AE project.', z.object({
    path: z.string().describe('Absolute local path on the PC'),
    sequence: z.boolean().default(false).describe('Import as image sequence'),
  }), WRITE, async (args, ctx) => aeRun(ctx, 'importFootage', args));

  run('ae_import_media_from_url', 'Import media from URL', 'Download a generated clip URL to the assets folder and import it into the AE project.', z.object({
    url: z.string().describe('http(s) URL of the media file (e.g. a clip Muse generated)'),
    filename: z.string().optional().describe('Preferred filename with extension'),
  }), { ...WRITE, openWorldHint: true }, async (args, ctx) => {
    const localPath = await downloadToAssets(args.url, ctx.assetsDir, args.filename);
    const r = await aeRun(ctx, 'importFootage', { path: localPath });
    return { localPath, import: r.result, ms: r.ms };
  });

  run('ae_save_project', 'Save AE project', 'Save the current project, optionally to a new .aep path.', z.object({
    path: z.string().optional().describe('Absolute .aep path; omit to save in place'),
  }), WRITE, async (args, ctx) => aeRun(ctx, 'saveProject', args));

  // --- render -----------------------------------------------------------------
  run('ae_render_comp', 'Render composition (aerender)', 'Render a composition with aerender.exe to a file. Blocks until done; use a generous timeout for long renders.', z.object({
    comp: z.string().describe('Composition name'),
    output: z.string().describe('Absolute output path, e.g. C:\\Shotbyx\\renders\\out.mp4'),
    projectPath: z.string().optional().describe('Absolute .aep path; defaults to the open project'),
    startFrame: z.number().int().min(0).optional(),
    endFrame: z.number().int().min(0).optional(),
    timeoutSeconds: z.number().int().min(30).max(7200).default(1800),
  }), WRITE, async (args, ctx) => {
    const info = await ctx.ae.hostInfo();
    if (!info.aerenderExe) throw new Error('aerender.exe not found — is After Effects installed?');
    let projectPath = args.projectPath as string | undefined;
    if (!projectPath) {
      const r = await aeRun(ctx, 'getProjectInfo', {}, 30000);
      const rec = r.result as Record<string, unknown>;
      projectPath = rec?.path as string;
      if (!projectPath) throw new Error('Project is unsaved — save it first (ae_save_project) or pass projectPath.');
    }
    const cli: string[] = ['-project', projectPath, '-comp', args.comp, '-output', args.output];
    if (args.startFrame !== undefined) cli.push('-s', String(args.startFrame));
    if (args.endFrame !== undefined) cli.push('-e', String(args.endFrame));
    return await new Promise((resolve, reject) => {
      execFile(info.aerenderExe as string, cli, { timeout: args.timeoutSeconds * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const tail = (s: string) => s.split(/\r?\n/).slice(-25).join('\n');
        if (err) {
          reject(new Error(`aerender failed: ${err.message}\n--- stdout ---\n${tail(stdout)}\n--- stderr ---\n${tail(stderr)}`));
        } else {
          resolve({ success: true, output: args.output, stdoutTail: tail(stdout) });
        }
      });
    });
  });

  // --- escape hatch -------------------------------------------------------------
  run('ae_run_command', 'Run raw AE bridge command', 'Escape hatch: send any panel command directly (list_compositions commands, bridgeTestEffects, etc.).', z.object({
    command: z.string().describe('Panel command name'),
    args: z.record(z.string(), z.unknown()).optional(),
    timeoutSeconds: z.number().int().min(5).max(600).default(90),
  }), WRITE, async (args, ctx) => aeRun(ctx, args.command, args.args ?? {}, args.timeoutSeconds * 1000));

  return tools;
}
