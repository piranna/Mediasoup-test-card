const {spawn} = require('child_process')
const {randomInt} = require('crypto')

const pathToFfmpeg = require('ffmpeg-static')


const defaultCodecs = {
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

const format = 'yuv420p'

// https://github.com/versatica/mediasoup/blob/v3/node/src/supportedRtpCapabilities.ts
const subtype2ffmpegCodec = {
  // Audio codecs.
  // 'cn': ,
  // 'g722': 'g722',
  'ilbc': 'libilbc',
  // 'isac': ,
  // 'multiopus': ,
  'opus': 'libopus',
  // 'pcma': ,
  // 'pcmu': ,
  // 'silk': ,
  // 'telephone-event': ,

  // Video codecs.
  'h264': 'libx264',
  'h265': 'libx265',
  'vp8': 'libvpx',
  'vp9': 'libvpx-vp9'
}


function genInput({producer: {kind}})
{
  const input = kind === 'audio'
    // https://www.ffmpeg.org/ffmpeg-all.html#sine
    ? 'sine=beep_factor=4:frequency=440'
    // https://libav.org/documentation/libavfilter.html#rgbtestsrc_002c-testsrc
    // https://www.ffmpeg.org/ffmpeg-all.html#allrgb_002c-allyuv_002c-color_002c-colorspectrum_002c-haldclutsrc_002c-nullsrc_002c-pal75bars_002c-pal100bars_002c-rgbtestsrc_002c-smptebars_002c-smptehdbars_002c-testsrc_002c-testsrc2_002c-yuvtestsrc
    // https://www.ffmpeg.org/ffmpeg-all.html#Video-size
    // https://www.ffmpeg.org/ffmpeg-all.html#Video-rate
    : `testsrc=rate=25:size=320x240,format=${format}`

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
  {codec: {channels, clockRate}, ffmpegCodec, producer: {kind}},
  input_file_id
) {
  const output_file_options = kind === 'audio'
  ? [
    '-ac', channels,
    '-ar', clockRate,
    '-codec:a', ffmpegCodec,
      '-b:a', '128k'  // TODO: make it configurable.
  ]
  : [
    '-pix_fmt', format,
    '-codec:v', ffmpegCodec,
      '-b:v', '1000k',  // TODO: make it configurable.
      '-cpu-used', '4',  // TODO: make it configurable.
      '-deadline', 'realtime'
  ]

  return ['-map', `${input_file_id}:0`, ...output_file_options]
}

function getProducer({producer})
{
  return producer
}

async function mapTestCard({codec, ffmpegCodec, kind})
{
  const {options, router} = this

  const transport = await router.createPlainTransport(options)

  await transport.connect({})

  const payloadType = kind === 'audio' ? 101 : 102

  // It seems `ssrc` value is a signed int32 in `ffmpeg`, so we can't get up to
  // full 32 bits values as dictates the spec. `0` means "disabled".
  const ssrc = randomInt(1, 2**31-1)

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

  return {codec, ffmpegCodec, payloadType, producer, ssrc, transport}
}

function hydrateTestCard(codec)
{
  // `codec` defined as a string, get it from default ones.
  if(typeof codec === 'string')
  {
    const kind = codec.toLowerCase()

    codec = defaultCodecs[kind]
    if(!codec) throw new Error(`Unknown codec: ${kind}`)
  }

  // Get `kind` and FFmpeg codec from MIME type.
  const {mimeType} = codec
  const [kind, subtype] = mimeType.split('/', 2)

  const ffmpegCodec = subtype2ffmpegCodec[subtype]
  if(!ffmpegCodec) throw new Error(`Unknown mime: ${mimeType}`)

  return {codec, ffmpegCodec, kind}
}


module.exports = async function(
  router, testCards, {debugMode, listenIp = '127.0.0.1'} = {}
) {
  if(!router) throw new Error('Missing router')
  if(!testCards) throw new Error('Missing testCards')

  const single = !Array.isArray(testCards)
  if(single) testCards = [testCards]
  if(!testCards.length) throw new Error('testCards is empty')

  testCards = testCards.map(hydrateTestCard)

  const options = {
    listenIp,
    // FFmpeg and GStreamer don't support RTP/RTCP multiplexing
    // ("a=rtcp-mux" in SDP)
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
