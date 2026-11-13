import Type, { type Static } from 'typebox';

import { EXIT_CATALOG, type ExitName } from './exits.js';
import { id } from './schema-id.js';

/**
 * The session statuses and the rules each one carries. Pure data describing current behavior. The kernel's
 * session-status policy derives every status set from it. Import `id` from `./schema-id.js`, never from
 * `./common.js`, which depends on this module.
 */

export const STATUS_KINDS = [
  'running',
  'not_started',
  'stage_stop',
  'session_stop',
  'terminal',
  'invalid',
] as const;
export type StatusKind = (typeof STATUS_KINDS)[number];

const EXIT_NAMES = EXIT_CATALOG.map((entry) => entry.name);

export const SessionStatusEntry = Type.Object(
  {
    name: Type.String({
      description: 'The status name as it appears in session records.',
    }),
    kind: Type.Unsafe<StatusKind>(
      Type.Union(
        STATUS_KINDS.map((value) => Type.Literal(value)),
        {
          description:
            'Classifies the status: a running session, one not started, a stop of a stage or of the session, a finished session, or an unreadable one.',
        },
      ),
    ),
    precedence: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()], {
      description:
        'Stage-stop rows only: the fold and the idle checks take the lowest value first.',
    }),
    exit: Type.Unsafe<ExitName | null>(
      Type.Union(
        [Type.Null(), ...EXIT_NAMES.map((value) => Type.Literal(value))],
        {
          description:
            'Name of the exit code that `session follow --exit-when-done` returns for this status, or null.',
        },
      ),
    ),
    ends_scheduling: Type.Boolean({
      description: 'No further stage is dispatched in this status.',
    }),
    manually_completable: Type.Boolean({
      description: '`session complete` accepts the status.',
    }),
    refreshable: Type.Boolean({
      description:
        'A draft can refresh the frozen config of a session in this status.',
    }),
    closed: Type.Boolean({
      description: 'The session can no longer adopt a draft.',
    }),
    terminal_fields: Type.Boolean({
      description: 'status.json carries the terminal keys in this status.',
    }),
    manifest: Type.Union(
      [Type.Literal('read'), Type.Literal('mirrored'), Type.Null()],
      {
        description:
          '`read`: the manifest status is read back. `mirrored`: it is also written. null: neither.',
      },
    ),
    resolution: Type.Union(
      [
        Type.Null(),
        Type.Object(
          { event: Type.String(), from: Type.Optional(Type.String()) },
          {
            description:
              'The event that resolves the stop, and its `from` value when the event has one.',
          },
        ),
      ],
      {
        description:
          'How a stop is resolved. null for a status that is not a stop.',
      },
    ),
  },
  {
    $id: id('session/session-status-entry'),
    title: 'Session status entry',
    description: 'One session status and the rules it carries.',
  },
);
export type SessionStatusEntry = Static<typeof SessionStatusEntry>;

const OFF = {
  ends_scheduling: false,
  manually_completable: false,
  refreshable: false,
  closed: false,
  terminal_fields: false,
} as const;

export const SESSION_STATUS_CATALOG = [
  {
    name: 'active',
    kind: 'running',
    precedence: null,
    exit: null,
    ...OFF,
    manually_completable: true,
    refreshable: true,
    manifest: null,
    resolution: null,
  },
  {
    name: 'prepared',
    kind: 'not_started',
    precedence: null,
    exit: null,
    ...OFF,
    manifest: 'read',
    resolution: null,
  },
  {
    name: 'completed',
    kind: 'terminal',
    precedence: null,
    exit: 'completed',
    ...OFF,
    ends_scheduling: true,
    closed: true,
    terminal_fields: true,
    manifest: 'mirrored',
    resolution: null,
  },
  {
    name: 'blocked',
    kind: 'stage_stop',
    precedence: 0,
    exit: 'blocked',
    ...OFF,
    ends_scheduling: true,
    manually_completable: true,
    refreshable: true,
    terminal_fields: true,
    manifest: 'mirrored',
    resolution: { event: 'session.active', from: 'blocked' },
  },
  {
    name: 'question',
    kind: 'stage_stop',
    precedence: 1,
    exit: 'question',
    ...OFF,
    ends_scheduling: true,
    manually_completable: true,
    refreshable: true,
    manifest: 'mirrored',
    resolution: { event: 'session.active', from: 'question' },
  },
  {
    name: 'expired',
    kind: 'stage_stop',
    precedence: 2,
    exit: 'resume_expired',
    ...OFF,
    ends_scheduling: true,
    manually_completable: true,
    refreshable: true,
    manifest: 'mirrored',
    resolution: { event: 'resume.decided' },
  },
  {
    name: 'cancelled',
    kind: 'session_stop',
    precedence: null,
    exit: 'cancelled',
    ...OFF,
    ends_scheduling: true,
    manually_completable: true,
    closed: true,
    terminal_fields: true,
    manifest: 'mirrored',
    resolution: { event: 'session.active', from: 'cancelled' },
  },
  {
    name: 'corrupt',
    kind: 'invalid',
    precedence: null,
    exit: null,
    ...OFF,
    manifest: null,
    resolution: null,
  },
] as const satisfies readonly SessionStatusEntry[];

export type SessionStatusName = (typeof SESSION_STATUS_CATALOG)[number]['name'];
