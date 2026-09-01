export const TERMINAL_IPC_CHANNELS = {
  CREATE: 'terminal:create',
  LIST: 'terminal:list',
  INSPECT: 'terminal:inspect',
  INPUT: 'terminal:input',
  RESIZE: 'terminal:resize',
  INTERRUPT: 'terminal:interrupt',
  CLOSE: 'terminal:close',
  SNAPSHOT: 'terminal:snapshot',
  OUTPUT: 'terminal:output',
  STATE_CHANGED: 'terminal:state-changed',
} as const
