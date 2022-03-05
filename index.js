import {spawn} from 'child_process'
import {randomInt} from 'crypto'

import pathToFfmpeg from 'ffmpeg-static'


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

function genStream({producer: {kind}}, input_file_id)
{
  const output_file_options = kind === 'audio'
  ? ['-acodec', 'libopus', '-ab', '128k', '-ac', '2', '-ar', '48000']
  : [
    '-pix_fmt', 'yuv420p', '-c:v', 'libvpx', '-b:v', '1000k',
    '-deadline', 'realtime', '-cpu-used', '4'
  ]

  return ['-map', `${input_file_id}:0`, ...output_file_options]
}

async function mapTestCard(kind)
{
  const {options, router} = this

  const codec = CODECS[kind]
  if(!codec) throw new Error(`Unknown codec: ${kind}`)

  const transport = await router.createPlainTransport(options)

  await transport.connect({})

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

  return {payloadType, producer, ssrc, transport}
}


export default async function(router, testCards, listenIp = '127.0.0.1')
{
  if(!router) throw new Error('Missing router')
  if(!testCards?.length) throw new Error('Missing testCards')

  const options = {
    listenIp,
    // FFmpeg and GStreamer don't support RTP/RTCP multiplexing ("a=rtcp-mux" in SDP)
    rtcpMux: false,
    comedia: true
  }

  const result = await Promise.all(
    testCards.map(mapTestCard, {options, router})
  )

  const inputs  = result.map(genInput)
  const streams = result.map(genStream)
  const outputs = result.map(genOutput, listenIp)

  const args = [
    // '-loglevel','info',
    '-readrate', '1',
    ...inputs.flat(),
    ...streams.flat(),
    '-f', 'tee', outputs.join('|')
  ]

  const cp = spawn(
    pathToFfmpeg, args, {stdio: [ 'ignore', 'ignore', 'inherit' ]}
  )


  function onClose()
  {
    // TODO: kill ffmpeg just only when all transports are closed.
    cp.kill()
  }

  for(const {transport: {observer}} of result)
    observer.once('close', onClose)

  return result
}
