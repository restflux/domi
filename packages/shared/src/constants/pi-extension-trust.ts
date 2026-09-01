/** Pi Extension trust 使用独立通道，不能与 Agent tool permission 混为同一授权。 */
export const PI_EXTENSION_TRUST_IPC_CHANNELS = {
  PICK_CANDIDATE: 'pi-extension-trust:pick-candidate',
  LIST: 'pi-extension-trust:list',
  APPROVE: 'pi-extension-trust:approve',
  REVOKE: 'pi-extension-trust:revoke',
} as const
