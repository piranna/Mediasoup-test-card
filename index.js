const {spawn} = require('child_process')
const {randomInt} = require('crypto')

const pathToFfmpeg = require('ffmpeg-static')


const CODECS = {
  audio: {
    channels  : 2,
    clockRate : 48000,
    mimeType  : 'audio/opus',
    parameters: { 'sprop-stereo': 1 }
  },
  video: {
    clockRate: 90000,
    mimeType : 'video/vp8',
  }
}


function genInput({producer: {kind}})
{
  const input = kind === 'audio'
    ? 'sine=f=440:b=4'
    : 'testsrc=d=5:s=1920x1080:r=24,format=yuv420p'

  return ['-f', 'lavfi', '-i', input]
}

function genOutput(
  {
    payloadType,
    producer: {kind},
    ssrc,
    transport: {
      rtcpTuple: {localPort: rtcpPort},
      tuple: {localPort: rtpPort}
    }
  }
) {
  const listenIp = this.toString()

  return `[select=${kind[0]}:f=rtp:ssrc=${ssrc}:payload_type=${payloadType}]`
  + `rtp://${listenIp}:${rtpPort}?rtcpport=${rtcpPort}`
}

function genStream(
  {codec: {channels, clockRate}, producer: {kind}}, input_file_id
) {
  const output_file_options = kind === 'audio'
  ? ['-acodec', 'libopus', '-ab', '128k', '-ac', channels, '-ar', clockRate]
  : [
    '-pix_fmt', 'yuv420p', '-c:v', 'libvpx', '-b:v', '1000k',
    '-deadline', 'realtime', '-cpu-used', '4'
  ]

  return ['-map', `${input_file_id}:0`, ...output_file_options]
}

function getProducer({producer})
{
  return producer
}

async function mapTestCard(codec)
{
  const {options, router} = this

  // `codec` defined as a string, get it from default ones.
  if(typeof codec === 'string')
  {
    const kind = codec.toLowerCase()

    codec = CODECS[kind]
    if(!codec) throw new Error(`Unknown codec: ${kind}`)
  }

  const transport = await router.createPlainTransport(options)

  await transport.connect({})

  const [kind] = codec.mimeType.split('/', 1)
  const payloadType = kind === 'audio' ? 101 : 102
  const ssrc = randomInt(1, 2**31-1)  // Seems `ssrc` is signed int32 in ffpmpeg

  const producer = await transport.produce({
    kind,
    rtpParameters:
    {
      codecs :
      [
        {
          ...codec,
          payloadType,
          rtcpFeedback: [ ]  // FFmpeg does not support NACK nor PLI/FIR.
        }
      ],
      encodings: [ { ssrc } ]
    }
  })

  producer.observer.once('close', transport.close.bind(transport))

  return {codec, payloadType, producer, ssrc, transport}
}


module.exports = async function(
  router, testCards, {debugMode, listenIp = '127.0.0.1'} = {}
) {
  if(!router) throw new Error('Missing router')
  if(!testCards) throw new Error('Missing testCards')

  let single = false
  if(!Array.isArray(testCards))
  {
    testCards = [testCards]
    single = true
  }
  if(!testCards.length) throw new Error('testCards is empty')

  const options = {
    listenIp,
    // FFmpeg and GStreamer don't support RTP/RTCP multiplexing ("a=rtcp-mux" in SDP)
    rtcpMux: false,
    comedia: true
  }

  testCards = await Promise.all(testCards.map(mapTestCard, {options, router}))

  const inputs  = testCards.map(genInput)
  const streams = testCards.map(genStream)
  const outputs = testCards.map(genOutput, listenIp)

  const args = [
    // '-loglevel','info',
    '-readrate', '1',
    ...inputs.flat(),
    ...streams.flat(),
    '-f', 'tee', outputs.join('|')
  ]

  if(debugMode) console.debug('ffmpeg', ...args)

  const cp = spawn(
    pathToFfmpeg, args,
    {stdio: [ 'ignore', 'ignore', debugMode ? 'inherit': 'ignore' ]}
  )

  const transports = new Set()

  for(const {transport} of testCards)
  {
    transports.add(transport)

    transport.observer.once('close', function()
    {
      transports.delete(transport)

      // Kill ffmpeg just only when all transports are closed.
      if(!transports.size) cp.kill()
    })
  }

  const result = testCards.map(getProducer)

  return single ? result[0] : result
}
