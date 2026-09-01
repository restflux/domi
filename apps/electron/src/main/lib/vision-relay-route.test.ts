import { describe, expect, test } from 'bun:test'
import {
  buildVisionRelayRouteIdentity,
  sanitizeVisionRelayDisplayText,
} from './vision-relay-route'

const channel = {
  id: 'vision-channel',
  name: 'Vision Channel',
  provider: 'openai' as const,
  baseUrl: 'https://vision.example/v1/',
  credentialVersion: 'credential-v1',
}

describe('Vision Relay route identity', () => {
  test('binds channel, endpoint, model and credential version into one routeKey', () => {
    const route = buildVisionRelayRouteIdentity(channel, 'vision-model')
    expect(route).toMatchObject({
      provider: 'openai',
      endpointHost: 'vision.example',
      channelName: 'Vision Channel',
      modelId: 'vision-model',
    })
    const changedEndpoint = buildVisionRelayRouteIdentity({ ...channel, baseUrl: 'https://evil.example/v1' }, 'vision-model')
    const changedProvider = buildVisionRelayRouteIdentity({ ...channel, provider: 'anthropic' }, 'vision-model')
    const changedQuery = buildVisionRelayRouteIdentity({ ...channel, baseUrl: 'https://vision.example/v1/?tenant=other' }, 'vision-model')
    const changedCredential = buildVisionRelayRouteIdentity({ ...channel, credentialVersion: 'credential-v2' }, 'vision-model')
    const changedModel = buildVisionRelayRouteIdentity(channel, 'other-model')
    const routeKey = route!.routeKey
    expect(changedEndpoint!.routeKey).not.toBe(routeKey)
    expect(changedProvider!.routeKey).not.toBe(routeKey)
    expect(changedQuery!.routeKey).not.toBe(routeKey)
    expect(changedCredential!.routeKey).not.toBe(routeKey)
    expect(changedModel!.routeKey).not.toBe(routeKey)
  })

  test('fails closed on blank model, missing credential version or invalid endpoint', () => {
    expect(buildVisionRelayRouteIdentity(channel, '   ')).toBeUndefined()
    expect(buildVisionRelayRouteIdentity({ ...channel, credentialVersion: '  ' }, 'vision-model')).toBeUndefined()
    expect(buildVisionRelayRouteIdentity({ ...channel, baseUrl: 'not-a-url' }, 'vision-model')).toBeUndefined()
  })

  test('display text removes controls and bidi overrides', () => {
    expect(sanitizeVisionRelayDisplayText('  a\n\u202eb  ', 'fallback')).toBe('ab')
  })
})
