import {createWorker, types} from 'mediasoup'

import mediasoupTestCard from '..'


const {PlainTransport, Producer} = types


const mediaCodecs =
[
  {
    kind        : "audio",
    mimeType    : "audio/opus",
    clockRate   : 48000,
    channels    : 2
  },
  {
    kind       : "video",
    mimeType   : "video/vp8",
    clockRate  : 90000,
    parameters :
    {
      'x-google-start-bitrate' : 1000
    }
  }
];
const routerOptions = {mediaCodecs}


test('layout', function()
{
  expect(mediasoupTestCard).toMatchInlineSnapshot(`[Function]`)
})

test('no arguments', async function()
{
  await expect(mediasoupTestCard).rejects.toThrowErrorMatchingInlineSnapshot(
    `"Missing router"`
  )
})

test('no testCards', async function()
{
  const promise = mediasoupTestCard({})

  await expect(promise).rejects.toThrowErrorMatchingInlineSnapshot(
    `"Missing testCards"`
  )
})

test('router is not a valid Router object', async function()
{
  const promise = mediasoupTestCard({}, ['audio'])

  await expect(promise).rejects.toThrowErrorMatchingInlineSnapshot(
    `"router.createPlainTransport is not a function"`
  )
})

describe('with Router', function()
{
  let router
  let worker

  beforeAll(async function()
  {
    worker = await createWorker()
  })

  beforeEach(async function()
  {
    router = await worker.createRouter(routerOptions)
  })

  afterEach(function()
  {
    router.close()
  })

  afterAll(function()
  {
    worker.close()
  })

  test('invalid codec', async function()
  {
    const promise = mediasoupTestCard(router, ['foo'])

    await expect(promise).rejects.toThrowErrorMatchingInlineSnapshot(
      `"Unknown codec: foo"`
    )
  })

  test('basic usage', async function()
  {
    const promise = mediasoupTestCard(router, ['audio', 'video'])

    await expect(promise).resolves.toMatchObject(
      [
        {
          "payloadType": 101,
          "producer": expect.any(Producer),
          "ssrc": expect.any(Number),
          "transport": expect.any(PlainTransport)
        },
        {
          "payloadType": 102,
          "producer": expect.any(Producer),
          "ssrc": expect.any(Number),
          "transport": expect.any(PlainTransport)
        }
      ]
    )
  })
})
