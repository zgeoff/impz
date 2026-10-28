import { assign, emit, setup } from 'xstate';
import type { ExecStream } from '../../../vm/agent-client/exec-stream';
import type { GenerationLog } from './generation-log';

export interface LiveLog {
  readonly key: string;
  readonly impId: string;
  readonly session: string;
  readonly generation: string;
  readonly log: GenerationLog;
}

export interface OpeningTap {
  readonly opening: true;
}

type TapSlot = Readonly<ExecStream> | OpeningTap;

interface SessionLogContext {
  readonly live: ReadonlyMap<string, LiveLog>;
  readonly taps: ReadonlyMap<string, TapSlot>;

  readonly dropped: ReadonlySet<string>;

  readonly recovered: ReadonlySet<string>;

  readonly creating: ReadonlySet<string>;

  readonly forgotten: ReadonlySet<string>;

  readonly lives: ReadonlyMap<string, number>;

  readonly capNotices: ReadonlyMap<string, number>;

  readonly uncheckedBytes: ReadonlyMap<string, number>;
}

interface ImpRecoverEvent {
  readonly type: 'imp.recover';
  readonly impId: string;
}

interface ImpForgetEvent {
  readonly type: 'imp.forget';
  readonly impId: string;
}

interface ImpAdmitEvent {
  readonly type: 'imp.admit';
  readonly impId: string;
}

interface LogAddEvent {
  readonly type: 'log.add';
  readonly entry: LiveLog;
  readonly isStopped: boolean;
}

interface LogEndEvent {
  readonly type: 'log.end';
  readonly entry: LiveLog;
}

interface LogStopEvent {
  readonly type: 'log.stop';
  readonly entry: LiveLog;
}

interface LogRemoveEvent {
  readonly type: 'log.remove';
  readonly key: string;
}

interface CreationStartEvent {
  readonly type: 'creation.start';
  readonly key: string;
}

interface CreationEndEvent {
  readonly type: 'creation.end';
  readonly key: string;
}

interface CapRefuseEvent {
  readonly type: 'cap.refuse';
  readonly impId: string;
  readonly at: number;
}

interface TapOpenEvent {
  readonly type: 'tap.open';
  readonly key: string;
  readonly slot: TapSlot;
}

interface TapAttachEvent {
  readonly type: 'tap.attach';
  readonly key: string;
  readonly opening: OpeningTap;
  readonly tap: Readonly<ExecStream>;
}

interface TapReleaseEvent {
  readonly type: 'tap.release';
  readonly key: string;
  readonly owner: TapSlot;
}

interface TapEndEvent {
  readonly type: 'tap.end';
  readonly key: string;
  readonly tap: Readonly<ExecStream>;
}

interface BytesAddEvent {
  readonly type: 'bytes.add';
  readonly impId: string;
  readonly bytes: number;
}

interface BytesClearEvent {
  readonly type: 'bytes.clear';
  readonly impId: string;
}

type SessionLogEvent =
  | ImpRecoverEvent
  | ImpForgetEvent
  | ImpAdmitEvent
  | LogAddEvent
  | LogEndEvent
  | LogStopEvent
  | LogRemoveEvent
  | CreationStartEvent
  | CreationEndEvent
  | CapRefuseEvent
  | TapOpenEvent
  | TapAttachEvent
  | TapReleaseEvent
  | TapEndEvent
  | BytesAddEvent
  | BytesClearEvent;

interface CapNoticeEvent {
  readonly type: 'cap.notice';
  readonly impId: string;
}

const CAP_NOTICE_MS = 60_000;

interface KeyParams {
  readonly key: string;
}

interface ImpParams {
  readonly impId: string;
}

interface EntryParams {
  readonly entry: LiveLog;
}

interface SlotParams {
  readonly key: string;
  readonly owner: TapSlot;
}

interface CapParams {
  readonly impId: string;
  readonly at: number;
}

// xstate's setup reads only the types of these fields, never a value, so an
// empty object serves.
interface SessionLogTypes {
  readonly context?: SessionLogContext;
  readonly events?: SessionLogEvent;
  readonly emitted?: CapNoticeEvent;
}

const types: SessionLogTypes = {};

export const sessionLogMachine = setup({
  types,
  guards: {
    isCurrent: (args, params: EntryParams) =>
      args.context.live.get(params.entry.key) === params.entry,
    isLive: (args, params: KeyParams) => args.context.live.has(params.key),
    canOpenTap: (args, params: KeyParams) =>
      !args.context.taps.has(params.key) && !args.context.dropped.has(params.key),
    isSlotOwner: (args, params: SlotParams) => args.context.taps.get(params.key) === params.owner,
    isCapNoticeDue: (args, params: CapParams) =>
      params.at - (args.context.capNotices.get(params.impId) ?? 0) >= CAP_NOTICE_MS,
  },
  actions: {
    stopTap: (args, params: KeyParams) => {
      const slot = args.context.taps.get(params.key);

      if (slot !== undefined && !isOpening(slot)) {
        slot.close();
      }
    },
    stopImpTaps: (args, params: ImpParams) => {
      for (const [key, slot] of args.context.taps) {
        if (isImpKey(key, params.impId) && !isOpening(slot)) {
          slot.close();
        }
      }
    },
    disposeLog: (args, params: KeyParams) => {
      args.context.live.get(params.key)?.log.abandon();
    },
    disposeImpLogs: (args, params: ImpParams) => {
      for (const entry of args.context.live.values()) {
        if (entry.impId === params.impId) {
          entry.log.abandon();
        }
      }
    },
  },
}).createMachine({
  id: 'sessionLogs',
  context: {
    live: new Map(),
    taps: new Map(),
    dropped: new Set(),
    recovered: new Set(),
    creating: new Set(),
    forgotten: new Set(),
    lives: new Map(),
    capNotices: new Map(),
    uncheckedBytes: new Map(),
  },
  on: {
    'imp.recover': {
      actions: assign({
        recovered: (args) => buildSetWith(args.context.recovered, args.event.impId),
      }),
    },
    'imp.forget': {
      actions: [
        { type: 'stopImpTaps', params: (args) => ({ impId: args.event.impId }) },
        { type: 'disposeImpLogs', params: (args) => ({ impId: args.event.impId }) },
        assign({
          forgotten: (args) => buildSetWith(args.context.forgotten, args.event.impId),
          lives: (args) =>
            buildMapWith(
              args.context.lives,
              args.event.impId,
              (args.context.lives.get(args.event.impId) ?? 0) + 1,
            ),
          live: (args) =>
            new Map([...args.context.live].filter(([, entry]) => entry.impId !== args.event.impId)),

          taps: (args) =>
            new Map([...args.context.taps].filter(([key]) => !isImpKey(key, args.event.impId))),
          recovered: (args) => buildSetWithout(args.context.recovered, args.event.impId),
          uncheckedBytes: (args) => buildMapWithout(args.context.uncheckedBytes, args.event.impId),
        }),
      ],
    },
    'imp.admit': {
      actions: assign({
        forgotten: (args) => buildSetWithout(args.context.forgotten, args.event.impId),
      }),
    },
    'log.add': {
      actions: assign({
        live: (args) => buildMapWith(args.context.live, args.event.entry.key, args.event.entry),
        dropped: (args) =>
          args.event.isStopped
            ? buildSetWith(args.context.dropped, args.event.entry.key)
            : args.context.dropped,
      }),
    },
    'log.end': {
      guard: { type: 'isCurrent', params: (args) => ({ entry: args.event.entry }) },
      actions: [
        { type: 'stopTap', params: (args) => ({ key: args.event.entry.key }) },
        assign({
          live: (args) => buildMapWithout(args.context.live, args.event.entry.key),
          taps: (args) => buildMapWithout(args.context.taps, args.event.entry.key),
        }),
      ],
    },
    'log.stop': {
      guard: { type: 'isCurrent', params: (args) => ({ entry: args.event.entry }) },
      actions: [
        { type: 'stopTap', params: (args) => ({ key: args.event.entry.key }) },
        assign({
          dropped: (args) => buildSetWith(args.context.dropped, args.event.entry.key),
          taps: (args) => buildMapWithout(args.context.taps, args.event.entry.key),
        }),
      ],
    },
    'log.remove': {
      guard: { type: 'isLive', params: (args) => ({ key: args.event.key }) },
      actions: [
        { type: 'stopTap', params: (args) => ({ key: args.event.key }) },
        { type: 'disposeLog', params: (args) => ({ key: args.event.key }) },
        assign({
          taps: (args) => buildMapWithout(args.context.taps, args.event.key),
          live: (args) => buildMapWithout(args.context.live, args.event.key),
          dropped: (args) => buildSetWith(args.context.dropped, args.event.key),
        }),
      ],
    },
    'creation.start': {
      actions: assign({
        creating: (args) => buildSetWith(args.context.creating, args.event.key),
      }),
    },
    'creation.end': {
      actions: assign({
        creating: (args) => buildSetWithout(args.context.creating, args.event.key),
      }),
    },
    'cap.refuse': {
      guard: {
        type: 'isCapNoticeDue',
        params: (args) => ({ impId: args.event.impId, at: args.event.at }),
      },
      actions: [
        emit((args): CapNoticeEvent => ({ type: 'cap.notice', impId: args.event.impId })),
        assign({
          capNotices: (args) =>
            buildMapWith(args.context.capNotices, args.event.impId, args.event.at),
        }),
      ],
    },
    'tap.open': {
      guard: { type: 'canOpenTap', params: (args) => ({ key: args.event.key }) },
      actions: assign({
        taps: (args) => buildMapWith(args.context.taps, args.event.key, args.event.slot),
      }),
    },
    'tap.attach': {
      guard: {
        type: 'isSlotOwner',
        params: (args) => ({ key: args.event.key, owner: args.event.opening }),
      },
      actions: assign({
        taps: (args) => buildMapWith(args.context.taps, args.event.key, args.event.tap),
      }),
    },
    'tap.release': {
      guard: {
        type: 'isSlotOwner',
        params: (args) => ({ key: args.event.key, owner: args.event.owner }),
      },
      actions: assign({
        taps: (args) => buildMapWithout(args.context.taps, args.event.key),
      }),
    },
    'tap.end': {
      guard: {
        type: 'isSlotOwner',
        params: (args) => ({ key: args.event.key, owner: args.event.tap }),
      },
      actions: [
        { type: 'stopTap', params: (args) => ({ key: args.event.key }) },
        assign({
          taps: (args) => buildMapWithout(args.context.taps, args.event.key),
        }),
      ],
    },
    'bytes.add': {
      actions: assign({
        uncheckedBytes: (args) =>
          buildMapWith(
            args.context.uncheckedBytes,
            args.event.impId,
            (args.context.uncheckedBytes.get(args.event.impId) ?? 0) + args.event.bytes,
          ),
      }),
    },
    'bytes.clear': {
      actions: assign({
        uncheckedBytes: (args) => buildMapWith(args.context.uncheckedBytes, args.event.impId, 0),
      }),
    },
  },
});

function isOpening(slot: TapSlot): slot is OpeningTap {
  return 'opening' in slot;
}

function isImpKey(key: string, impId: string): boolean {
  return key.startsWith(`${impId}/`);
}

function buildSetWith<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  return new Set([...set, value]);
}

function buildMapWith<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  return new Map([...map, [key, value]]);
}

function buildSetWithout<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  return new Set([...set].filter((each) => each !== value));
}

function buildMapWithout<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  return new Map([...map].filter(([each]) => each !== key));
}
