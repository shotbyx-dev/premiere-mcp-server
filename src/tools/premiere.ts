/**
 * Curated Premiere Pro tool profile.
 *
 * Each tool generates ExtendScript (ES3) that runs inside Premiere via the
 * CEP bridge panel's CSInterface.evalScript. The JSON-compat prelude is
 * prepended automatically by the bridge, so scripts can `return JSON.stringify(...)`.
 *
 * Conventions:
 * - Time is expressed in SECONDS (float) in tool args; converted to ticks
 *   (254,016,000 per second) inside the generated script.
 * - Clips are referenced as { track: "v1"|"a1"|..., index: 0-based }.
 * - Write tools are annotated destructiveHint/idempotentHint for the client's
 *   approval UI. Nothing here bypasses the modal-dialog problem: if Premiere
 *   shows a native dialog, the bridge wedges until a human dismisses it
 *   (see probe_modal_dialog).
 */
import { stat } from 'node:fs/promises';
import * as z from 'zod/v4';
import { downloadToAssets } from './download.js';
import { detectBeats } from './beats.js';
import { FileQueueBridge } from '../bridge/fileQueue.js';

export const TICKS_PER_SECOND = 254016000;

export interface ToolContext {
  bridge: FileQueueBridge;
  assetsDir: string;
  caller: string;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  annotations: ToolAnnotations;
  run: (args: any, ctx: ToolContext) => Promise<unknown>;
}

const RO: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const MODAL_PRONE_EXT = new Set(['.ass', '.ssa']);

/** Find a project item by name (depth-first). Returns null JSON if missing. */
const FIND_ITEM_FN = `
function __findItem(node, name) {
  var n = node.children ? node.children.numItems : 0;
  for (var i = 0; i < n; i++) {
    var child = node.children[i];
    if (String(child.name) === name) return child;
    if (child.type === 2) { var found = __findItem(child, name); if (found) return found; }
  }
  return null;
}`;

function activeSeqGuard(): string {
  return `var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ success: false, error: "No active sequence. Open a project and select a sequence first." });`;
}

function trackRef(track: string): { collection: string; idx: string } {
  const m = /^([va])(\d+)$/i.exec(track || '');
  if (!m) throw new Error(`Bad track ref "${track}" — use like "v1" or "a2".`);
  return {
    collection: m[1].toLowerCase() === 'v' ? 'seq.videoTracks' : 'seq.audioTracks',
    idx: String(parseInt(m[2], 10) - 1),
  };
}

const clipRefSchema = z.object({
  track: z.string().describe('Track reference like "v1" (video 1) or "a1" (audio 1)'),
  index: z.number().int().min(0).describe('0-based clip index on the track'),
});

export function buildPremiereTools(): ToolDef[] {
  const tools: ToolDef[] = [];

  const add = (def: ToolDef) => {
    tools.push(def);
  };

  // ---------- connection / lifecycle ----------

  add({
    name: 'verify_premiere_connection',
    title: 'Verify Premiere Pro connection',
    description:
      'Check that Premiere Pro is running and the MCP Bridge panel is connected. ' +
      'Optionally auto-launch Premiere if it is not running. Call this before any editing tool.',
    inputSchema: z.object({
      launch: z.boolean().default(true).describe('Launch Premiere Pro if it is not running'),
    }),
    annotations: RO,
    run: async (args, ctx) => ctx.bridge.ensureHost({ launchIfNeeded: args.launch }),
  });

  add({
    name: 'probe_modal_dialog',
    title: 'Probe for blocking modal dialog',
    description:
      'Detect whether a native modal dialog is blocking Premiere (the #1 cause of a wedged bridge). ' +
      'If modalOpen is true, a human must dismiss the dialog in the Premiere UI before any other tool will work.',
    inputSchema: z.object({}),
    annotations: RO,
    run: async (_args, ctx) => {
      const script = `
        app.enableQE();
        var id = 0;
        try { id = qe.getModalWindowID(); } catch (e) {}
        return JSON.stringify({ modalOpen: id !== 0, windowId: id });`;
      const r = (await ctx.bridge.executeScript(script, 15000)) as any;
      const parsed = typeof r === 'string' ? JSON.parse(r) : r;
      return {
        ...parsed,
        userActionRequired: parsed.modalOpen === true,
        nextStep: parsed.modalOpen
          ? 'A modal dialog is blocking Premiere. Dismiss it in the Premiere UI, then retry.'
          : 'No blocking dialog detected.',
      };
    },
  });

  add({
    name: 'get_version_info',
    title: 'Get Premiere version info',
    description: 'Return the Premiere Pro version and build. Useful to know which QE DOM quirks apply.',
    inputSchema: z.object({}),
    annotations: RO,
    run: async (_args, ctx) => {
      const r = await ctx.bridge.executeScript(
        `return JSON.stringify({ version: String(app.version), build: String(app.build) });`,
        15000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  // ---------- project ----------

  add({
    name: 'get_project_info',
    title: 'Get project info',
    description: 'Return the active project name, path, and sequence count.',
    inputSchema: z.object({}),
    annotations: RO,
    run: async (_args, ctx) => {
      const r = await ctx.bridge.executeScript(
        `var p = app.project;
         return JSON.stringify({ name: p ? String(p.name) : null, path: p ? String(p.path) : null,
           numSequences: p && p.sequences ? p.sequences.numSequences : 0 });`,
        15000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'open_project',
    title: 'Open project',
    description: 'Open a .prproj project file in Premiere Pro.',
    inputSchema: z.object({
      path: z.string().describe('Full Windows path to the .prproj file'),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const r = await ctx.bridge.executeScript(
        `app.openDocument(${JSON.stringify(args.path)});
         return JSON.stringify({ success: true, project: String(app.project.name) });`,
        60000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'create_project',
    title: 'Create project',
    description: 'Create a new .prproj project file and open it in Premiere Pro.',
    inputSchema: z.object({
      path: z.string().describe('Full Windows path for the new .prproj file, e.g. C:\\Shotbyx\\Projects\\edit.prproj'),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const r = await ctx.bridge.executeScript(
        `app.newProject(${JSON.stringify(args.path)});
         return JSON.stringify({ success: true, project: String(app.project.name), path: String(app.project.path) });`,
        60000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'save_project',
    title: 'Save project',
    description: 'Save the active project.',
    inputSchema: z.object({}),
    annotations: WRITE,
    run: async (_args, ctx) => {
      const r = await ctx.bridge.executeScript(
        `app.project.save(); return JSON.stringify({ success: true });`,
        30000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'list_project_items',
    title: 'List project items',
    description: 'List top-level items in the project panel (name + type).',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).default(50),
    }),
    annotations: RO,
    run: async (args, ctx) => {
      const r = await ctx.bridge.executeScript(
        `${FIND_ITEM_FN}
         var root = app.project.rootItem; var out = [];
         var n = Math.min(root.children.numItems, ${args.limit});
         for (var i = 0; i < n; i++) { var c = root.children[i]; out.push({ name: String(c.name), type: c.type }); }
         return JSON.stringify({ items: out, total: root.children.numItems });`,
        20000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'create_bin',
    title: 'Create bin',
    description: 'Create a new bin in the project panel.',
    inputSchema: z.object({ name: z.string() }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const r = await ctx.bridge.executeScript(
        `app.project.rootItem.createBin(${JSON.stringify(args.name)});
         return JSON.stringify({ success: true, name: ${JSON.stringify(args.name)} });`,
        15000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'import_media',
    title: 'Import media files',
    description:
      'Import local media files into the project. Subtitle formats (.ass/.ssa) are refused ' +
      'because they pop a modal dialog that wedges the bridge.',
    inputSchema: z.object({
      paths: z.array(z.string()).min(1).describe('Full Windows paths to import'),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      for (const p of args.paths as string[]) {
        const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
        if (MODAL_PRONE_EXT.has(ext)) {
          throw new Error(`Refusing to import "${p}": ${ext} files pop a modal dialog in Premiere.`);
        }
      }
      const r = await ctx.bridge.executeScript(
        `app.project.importFiles(${JSON.stringify(args.paths)}, true, app.project.rootItem, false);
         return JSON.stringify({ success: true, count: ${(args.paths as string[]).length} });`,
        120000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'import_media_from_url',
    title: 'Import media from URL',
    description:
      'Download a media file from an http(s) URL into the server assets folder and import it ' +
      'into the Premiere project. This is the handoff for AI-generated clips: the assistant ' +
      'generates video itself (e.g. animating a still), uploads it to a share URL, then calls ' +
      'this tool with that URL. Max 500 MB; video/image/audio content only.',
    inputSchema: z.object({
      url: z.string().describe('Direct http(s) URL to the media file'),
      filename: z.string().optional().describe('Preferred filename (must include extension, e.g. clip.mp4)'),
    }),
    annotations: { ...WRITE, openWorldHint: true },
    run: async (args, ctx) => {
      const localPath = await downloadToAssets(args.url, ctx.assetsDir, args.filename);
      const st = await stat(localPath);
      const r = await ctx.bridge.executeScript(
        `app.project.importFiles(${JSON.stringify([localPath])}, true, app.project.rootItem, false);
         return JSON.stringify({ success: true });`,
        120000
      );
      const parsed = typeof r === 'string' ? JSON.parse(r) : r;
      return { ...parsed, localPath, bytes: st.size, sourceUrl: args.url };
    },
  });

  // ---------- sequences ----------

  add({
    name: 'list_sequences',
    title: 'List sequences',
    description: 'List all sequences in the project with name and id.',
    inputSchema: z.object({}),
    annotations: RO,
    run: async (_args, ctx) => {
      const r = await ctx.bridge.executeScript(
        `var out = []; var n = app.project.sequences.numSequences;
         for (var i = 0; i < n; i++) { var s = app.project.sequences[i]; out.push({ name: String(s.name), id: String(s.sequenceID) }); }
         return JSON.stringify({ sequences: out });`,
        20000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'set_active_sequence',
    title: 'Set active sequence',
    description: 'Make a sequence the active (target) sequence by name.',
    inputSchema: z.object({ name: z.string() }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const r = await ctx.bridge.executeScript(
        `${FIND_ITEM_FN}
         var n = app.project.sequences.numSequences; var target = null;
         for (var i = 0; i < n; i++) { if (String(app.project.sequences[i].name) === ${JSON.stringify(args.name)}) { target = app.project.sequences[i]; break; } }
         if (!target) return JSON.stringify({ success: false, error: "Sequence not found: " + ${JSON.stringify(args.name)} });
         app.project.activeSequence = target;
         return JSON.stringify({ success: true, name: ${JSON.stringify(args.name)} });`,
        20000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'create_sequence',
    title: 'Create sequence',
    description:
      'Create a new sequence. With default settings when presetPath is omitted; pass a real ' +
      '.sqpreset path for custom settings (never opens the New Sequence dialog).',
    inputSchema: z.object({
      name: z.string(),
      presetPath: z.string().optional().describe('Full path to a .sqpreset file'),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const script = args.presetPath
        ? `app.enableQE();
           var s = qe.project.newSequence(${JSON.stringify(args.name)}, ${JSON.stringify(args.presetPath)});
           return JSON.stringify({ success: !!s, name: ${JSON.stringify(args.name)} });`
        : `var s = app.project.createNewSequence(${JSON.stringify(args.name)}, "");
           return JSON.stringify({ success: !!s, name: ${JSON.stringify(args.name)} });`;
      const r = await ctx.bridge.executeScript(script, 30000);
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  // ---------- timeline ----------

  add({
    name: 'add_to_timeline',
    title: 'Add clip to timeline',
    description: 'Insert (ripple) or overwrite a project item onto the timeline at a time in seconds.',
    inputSchema: z.object({
      itemName: z.string().describe('Project item name to add'),
      timeSeconds: z.number().min(0).default(0),
      videoTrack: z.number().int().min(1).default(1),
      audioTrack: z.number().int().min(1).default(1),
      overwrite: z.boolean().default(false).describe('true = overwrite edit, false = ripple insert'),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const ticks = Math.round(args.timeSeconds * TICKS_PER_SECOND);
      const r = await ctx.bridge.executeScript(
        `${FIND_ITEM_FN}
         ${activeSeqGuard()}
         var item = __findItem(app.project.rootItem, ${JSON.stringify(args.itemName)});
         if (!item) return JSON.stringify({ success: false, error: "Project item not found: " + ${JSON.stringify(args.itemName)} });
         if (${args.overwrite}) seq.overwriteClip(item, ${ticks}, ${args.videoTrack - 1}, ${args.audioTrack - 1});
         else seq.insertClip(item, ${ticks}, ${args.videoTrack - 1}, ${args.audioTrack - 1});
         return JSON.stringify({ success: true });`,
        60000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'get_clip_properties',
    title: 'Get clip properties',
    description: 'Read a clip\'s in/out/start/end times (seconds) and Motion values.',
    inputSchema: z.object({ clip: clipRefSchema }),
    annotations: RO,
    run: async (args, ctx) => {
      const t = trackRef(args.clip.track);
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         var track = ${t.collection}[${t.idx}];
         if (!track) return JSON.stringify({ success: false, error: "Track not found" });
         var clip = track.clips[${args.clip.index}];
         if (!clip) return JSON.stringify({ success: false, error: "Clip index out of range" });
         var motion = null;
         try {
           var comp = clip.components[0];
           motion = { position: String(comp.properties[0].getValue()), scale: String(comp.properties[1].getValue()) };
         } catch (e) {}
         return JSON.stringify({ success: true, name: String(clip.name),
           start: clip.start.seconds, end: clip.end.seconds,
           inPoint: clip.inPoint.seconds, outPoint: clip.outPoint.seconds,
           duration: clip.duration.seconds, motion: motion });`,
        20000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'trim_clip',
    title: 'Trim clip',
    description: 'Set a clip\'s in and out points in seconds (extend/shorten within available media).',
    inputSchema: z.object({
      clip: clipRefSchema,
      inSeconds: z.number().min(0).optional(),
      outSeconds: z.number().min(0).optional(),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const t = trackRef(args.clip.track);
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         var clip = ${t.collection}[${t.idx}].clips[${args.clip.index}];
         if (!clip) return JSON.stringify({ success: false, error: "Clip not found" });
         ${args.inSeconds !== undefined ? `clip.inPoint.seconds = ${args.inSeconds};` : ''}
         ${args.outSeconds !== undefined ? `clip.outPoint.seconds = ${args.outSeconds};` : ''}
         return JSON.stringify({ success: true });`,
        30000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'move_clip',
    title: 'Move clip',
    description: 'Move a clip to a new start time in seconds on the same track.',
    inputSchema: z.object({
      clip: clipRefSchema,
      startSeconds: z.number().min(0),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const t = trackRef(args.clip.track);
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         var clip = ${t.collection}[${t.idx}].clips[${args.clip.index}];
         if (!clip) return JSON.stringify({ success: false, error: "Clip not found" });
         clip.start.seconds = ${args.startSeconds};
         return JSON.stringify({ success: true });`,
        30000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'split_clip',
    title: 'Split clip at playhead time',
    description: 'Razor a clip at the given time in seconds.',
    inputSchema: z.object({
      clip: clipRefSchema,
      atSeconds: z.number().min(0),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const t = trackRef(args.clip.track);
      const ticks = Math.round(args.atSeconds * TICKS_PER_SECOND);
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         var track = ${t.collection}[${t.idx}];
         var clip = track.clips[${args.clip.index}];
         if (!clip) return JSON.stringify({ success: false, error: "Clip not found" });
         track.splitClip(clip, ${ticks});
         return JSON.stringify({ success: true });`,
        30000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'remove_from_timeline',
    title: 'Remove clip from timeline',
    description: 'Delete a clip from the timeline. Set ripple=true to close the gap (hand-rolled: remove + shift later clips).',
    inputSchema: z.object({
      clip: clipRefSchema,
      ripple: z.boolean().default(false),
    }),
    annotations: DESTRUCTIVE,
    run: async (args, ctx) => {
      const t = trackRef(args.clip.track);
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         var track = ${t.collection}[${t.idx}];
         var clip = track.clips[${args.clip.index}];
         if (!clip) return JSON.stringify({ success: false, error: "Clip not found" });
         var gap = 0;
         ${args.ripple ? 'gap = clip.end.seconds - clip.start.seconds;' : ''}
         clip.remove(false, false);
         ${args.ripple ? `for (var i = 0; i < track.clips.numItems; i++) { var c = track.clips[i]; if (c.start.seconds >= clip.end.seconds) { c.start.seconds = c.start.seconds - gap; } }` : ''}
         return JSON.stringify({ success: true });`,
        30000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'get_playhead_position',
    title: 'Get playhead position',
    description: 'Return the playhead position in seconds on the active sequence.',
    inputSchema: z.object({}),
    annotations: RO,
    run: async (_args, ctx) => {
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         return JSON.stringify({ seconds: seq.getPlayerPosition().seconds });`,
        15000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'set_playhead_position',
    title: 'Set playhead position',
    description: 'Move the playhead to a time in seconds.',
    inputSchema: z.object({ seconds: z.number().min(0) }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const ticks = Math.round(args.seconds * TICKS_PER_SECOND);
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         seq.setPlayerPosition(${ticks});
         return JSON.stringify({ success: true });`,
        15000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  // ---------- markers ----------

  add({
    name: 'add_marker',
    title: 'Add marker',
    description: 'Add a marker at a time in seconds on the active sequence.',
    inputSchema: z.object({
      seconds: z.number().min(0),
      name: z.string().default(''),
      comments: z.string().default(''),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const ticks = Math.round(args.seconds * TICKS_PER_SECOND);
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         var m = seq.markers.createMarker(${ticks});
         m.name = ${JSON.stringify(args.name)}; m.comments = ${JSON.stringify(args.comments)};
         return JSON.stringify({ success: true });`,
        15000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'detect_beats',
    title: 'Detect beats in an audio file',
    description:
      'Analyze an audio file on the Windows PC and return its BPM, beat times in ' +
      'seconds, and a 0..1 confidence score. Pure TypeScript DSP (ffmpeg decode + ' +
      'spectral-flux onset detection + autocorrelation tempo + beat-grid snapping); ' +
      'no extra installs beyond ffmpeg. With writeMarkers=true the beats are also ' +
      'written to the active sequence as "Beat N" markers in ONE bridge call, ready ' +
      'for split_clip-at-beats editing. Typical flow: detect_beats(writeMarkers=true) ' +
      '-> split_clip at each beat to cut footage to the music.',
    inputSchema: z.object({
      audioPath: z.string().describe('Full path to the audio file on the Windows PC'),
      minBpm: z.number().min(30).max(300).default(70),
      maxBpm: z.number().min(30).max(300).default(180),
      writeMarkers: z
        .boolean()
        .default(false)
        .describe('Also write "Beat N" markers to the active sequence (single bridge call)'),
    }),
    annotations: WRITE, // read-only when writeMarkers=false; annotated WRITE because it can mutate the timeline
    run: async (args, ctx) => {
      const det = await detectBeats(args.audioPath, {
        minBpm: args.minBpm,
        maxBpm: args.maxBpm,
      });
      let markersWritten = 0;
      if (args.writeMarkers && det.beats.length > 0) {
        const capped = det.beats.slice(0, 2000); // keep one script snappy
        const r = await ctx.bridge.executeScript(
          `${activeSeqGuard()}
           var __times = ${JSON.stringify(capped)};
           var __n = 0;
           for (var i = 0; i < __times.length; i++) {
             var __m = seq.markers.createMarker(Math.round(__times[i] * ${TICKS_PER_SECOND}));
             __m.name = "Beat " + (i + 1);
             __n++;
           }
           return JSON.stringify({ success: true, markersWritten: __n });`,
          60000
        );
        const parsed = typeof r === 'string' ? JSON.parse(r) : r;
        markersWritten = parsed.markersWritten ?? 0;
      }
      return { ...det, markersWritten };
    },
  });

  add({
    name: 'list_markers',
    title: 'List markers',
    description: 'List markers on the active sequence.',
    inputSchema: z.object({}),
    annotations: RO,
    run: async (_args, ctx) => {
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         var out = []; var markers = seq.markers;
         for (var i = 0; i < markers.numMarkers; i++) { var m = markers.getMarkerByIndex(i); out.push({ name: String(m.name), seconds: m.start.seconds, comments: String(m.comments) }); }
         return JSON.stringify({ markers: out });`,
        15000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  // ---------- effects / transitions (QE DOM) ----------

  add({
    name: 'apply_effect',
    title: 'Apply effect by name',
    description:
      'Apply a video effect to a clip by its internal name (e.g. "AE.ADBE Gaussian Blur 2"). ' +
      'Use list_available_effects to discover names.',
    inputSchema: z.object({
      clip: clipRefSchema,
      effectName: z.string(),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      if (!/^v/i.test(args.clip.track)) throw new Error('Effects apply to video tracks only.');
      const t = trackRef(args.clip.track);
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         app.enableQE();
         var track = ${t.collection}[${t.idx}];
         var clip = track.clips[${args.clip.index}];
         if (!clip) return JSON.stringify({ success: false, error: "Clip not found" });
         var fx = qe.project.getVideoEffectByName(${JSON.stringify(args.effectName)});
         if (!fx) return JSON.stringify({ success: false, error: "Effect not found: " + ${JSON.stringify(args.effectName)} });
         var qeClip = qe.project.getActiveSequence().getVideoTrackAt(${t.idx}).getItemAt(${args.clip.index});
         qeClip.addVideoEffect(fx);
         return JSON.stringify({ success: true });`,
        45000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'add_transition',
    title: 'Add transition',
    description: 'Add a video transition (e.g. "Cross Dissolve") to the head of a clip.',
    inputSchema: z.object({
      clip: clipRefSchema,
      transitionName: z.string().default('Cross Dissolve'),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const t = trackRef(args.clip.track);
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         app.enableQE();
         var tr = qe.project.getVideoTransitionByName(${JSON.stringify(args.transitionName)});
         if (!tr) return JSON.stringify({ success: false, error: "Transition not found" });
         var qeClip = qe.project.getActiveSequence().getVideoTrackAt(${t.idx}).getItemAt(${args.clip.index});
         qeClip.addTransition(tr, true);
         return JSON.stringify({ success: true });`,
        45000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'list_available_effects',
    title: 'List available effects',
    description: 'List video effect display names available in this Premiere installation.',
    inputSchema: z.object({}),
    annotations: RO,
    run: async (_args, ctx) => {
      const r = await ctx.bridge.executeScript(
        `app.enableQE();
         var out = []; var n = qe.project.numVideoEffects;
         for (var i = 0; i < n; i++) { try { out.push(String(qe.project.getVideoEffectAt(i).displayName)); } catch (e) {} }
         return JSON.stringify({ effects: out });`,
        30000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'add_keyframe',
    title: 'Add keyframe',
    description: 'Add a keyframe to a clip effect property (Motion/Opacity components by index).',
    inputSchema: z.object({
      clip: clipRefSchema,
      componentIndex: z.number().int().min(0).describe('0=Motion, 1=Opacity, 2+=applied effects'),
      propertyIndex: z.number().int().min(0),
      seconds: z.number().min(0),
      value: z.string().describe('Value as string (parsed per property type)'),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const t = trackRef(args.clip.track);
      const ticks = Math.round(args.seconds * TICKS_PER_SECOND);
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         var clip = ${t.collection}[${t.idx}].clips[${args.clip.index}];
         if (!clip) return JSON.stringify({ success: false, error: "Clip not found" });
         var prop = clip.components[${args.componentIndex}].properties[${args.propertyIndex}];
         prop.addKey(${ticks});
         return JSON.stringify({ success: true });`,
        30000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  // ---------- audio ----------

  add({
    name: 'adjust_audio_levels',
    title: 'Adjust audio levels',
    description: 'Set the audio gain (dB) of a clip on an audio track.',
    inputSchema: z.object({
      clip: clipRefSchema,
      db: z.number().min(-60).max(12),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      if (!/^a/i.test(args.clip.track)) throw new Error('Audio levels apply to audio tracks only.');
      const t = trackRef(args.clip.track);
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         var clip = ${t.collection}[${t.idx}].clips[${args.clip.index}];
         if (!clip) return JSON.stringify({ success: false, error: "Clip not found" });
         clip.setAudioLevels(${args.db});
         return JSON.stringify({ success: true });`,
        30000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'mute_track',
    title: 'Mute/unmute track',
    description: 'Mute or unmute an audio track.',
    inputSchema: z.object({
      track: z.string().describe('e.g. "a1"'),
      mute: z.boolean().default(true),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const t = trackRef(args.track);
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         var track = ${t.collection}[${t.idx}];
         if (!track) return JSON.stringify({ success: false, error: "Track not found" });
         track.mute(${args.mute});
         return JSON.stringify({ success: true });`,
        15000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  // ---------- graphics ----------

  add({
    name: 'add_text_overlay',
    title: 'Add text overlay (MOGRT)',
    description:
      'Add a text/graphic overlay using a .mogrt template file. Premiere cannot create text ' +
      'from scratch — a real .mogrt path is required.',
    inputSchema: z.object({
      mogrtPath: z.string().describe('Full path to the .mogrt template'),
      seconds: z.number().min(0).default(0),
      videoTrack: z.number().int().min(1).default(2),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const ticks = Math.round(args.seconds * TICKS_PER_SECOND);
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         var item = seq.importMGT(${JSON.stringify(args.mogrtPath)}, ${ticks}, ${args.videoTrack - 1}, 0);
         return JSON.stringify({ success: !!item });`,
        60000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  // ---------- export ----------

  add({
    name: 'export_sequence',
    title: 'Export sequence via Media Encoder',
    description:
      'Queue the active sequence in Adobe Media Encoder and start the queue. ' +
      'Requires AME installed. Returns immediately; poll get_render_queue_status.',
    inputSchema: z.object({
      outputPath: z.string().describe('Full output path, e.g. C:\\Exports\\cut.mp4'),
      presetPath: z.string().optional().describe('Full path to an AME .epr preset'),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         app.encoder.launchEncoder();
         app.encoder.encodeSequence(seq, ${JSON.stringify(args.outputPath)},
           ${args.presetPath ? JSON.stringify(args.presetPath) : '""'},
           app.encoder.ENCODE_IN_TO_OUT, true, true);
         return JSON.stringify({ success: true, outputPath: ${JSON.stringify(args.outputPath)} });`,
        60000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'export_frame',
    title: 'Export frame',
    description: 'Export the current frame (or a given time) as a still image (PNG).',
    inputSchema: z.object({
      outputPath: z.string().describe('Full output path ending in .png'),
      seconds: z.number().min(0).optional(),
    }),
    annotations: WRITE,
    run: async (args, ctx) => {
      const r = await ctx.bridge.executeScript(
        `${activeSeqGuard()}
         ${args.seconds !== undefined ? `seq.setPlayerPosition(${Math.round(args.seconds * TICKS_PER_SECOND)});` : ''}
         app.enableQE();
         qe.project.getActiveSequence().exportFramePNG(${JSON.stringify(args.outputPath)});
         return JSON.stringify({ success: true, outputPath: ${JSON.stringify(args.outputPath)} });`,
        60000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  add({
    name: 'get_render_queue_status',
    title: 'Get render queue status',
    description: 'Report Adobe Media Encoder queue state (guidance-level; needs AME running).',
    inputSchema: z.object({}),
    annotations: RO,
    run: async (_args, ctx) => {
      const r = await ctx.bridge.executeScript(
        `var q = app.encoder;
         return JSON.stringify({ batchInProgress: q.isBatchInProgress(), queueCount: q.getQueueCount ? q.getQueueCount() : null });`,
        15000
      );
      return typeof r === 'string' ? JSON.parse(r) : r;
    },
  });

  // ---------- escape hatch ----------

  add({
    name: 'execute_extendscript',
    title: 'Execute raw ExtendScript',
    description:
      'Run arbitrary ExtendScript inside Premiere. Escape hatch for anything the curated tools ' +
      'do not cover. The JSON-compat prelude is prepended automatically; end with `return JSON.stringify(...)`. ' +
      'WARNING: arbitrary code execution — use only when a curated tool cannot do the job.',
    inputSchema: z.object({
      script: z.string().describe('ExtendScript (ES3) source'),
      timeoutMs: z.number().int().min(1000).max(300000).default(60000),
    }),
    annotations: DESTRUCTIVE,
    run: async (args, ctx) => {
      const r = await ctx.bridge.executeScript(args.script, args.timeoutMs);
      return typeof r === 'string' ? r : JSON.stringify(r);
    },
  });

  return tools;
}
