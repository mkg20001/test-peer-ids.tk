'use strict'

/* eslint-disable guard-for-in */
/* eslint-disable no-loop-func */

/* Config */

const production = process.env.NODE_ENV === 'production'
const commonPairs = production ? [['rsa', 2048], ['rsa', 1024], ['rsa', 512]] : [['rsa', 1024]]
const uncommonPairs = production ? [['rsa', 16384], ['rsa', 8192], ['rsa', 4096]] : []
const commonCache = production ? 100 : 10
const uncommonCache = production ? 10 : 2

/* Code */

const Hapi = require('hapi')
const cluster = require('cluster')
const numCPUs = require('os').cpus().length
const path = require('path')

const debug = require('debug')
const log = debug('test-peer-ids#' + process.pid)
const Id = require('peer-id')

let cache = {}

let doTask

async function taskWrapper (type, size) {
  try {
    return await doTask(type, size)
  } catch (e) {
    log(e)
    return taskWrapper(type, size)
  }
}

async function fillCache () {
  let changed = 1

  while (changed) {
    changed = 0
    for (const type in cache) {
      for (const size in cache[type]) {
        let obj = cache[type][size]
        if (obj.keys.length < obj.amount) {
          console.log('Queue', type, size)
          obj.keys.push(taskWrapper(type, parseInt(size, 10)))
          changed++
        }
      }
    }
  }
}

async function prepareCache (type, size) {
  if (!cache[type]) cache[type] = {}
  if (!cache[type][size]) {
    cache[type][size] = {amount: commonPairs.map(a => a.join('_')).indexOf(type + '_' + size) === -1 ? uncommonCache : commonCache, keys: []}
    console.log('Added', type, size, cache[type][size])
  }
}

async function getKey (type, size) {
  await prepareCache(type, size)
  await fillCache()

  return cache[type][size].keys.shift()
}

if (cluster.isMaster) {
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork()
  }

  let readyWorkers = []
  let waitingProm = []
  let workerProm = {}

  const getWorker = () => new Promise((resolve, reject) => {
    if (readyWorkers.length) return resolve(readyWorkers.shift())
    waitingProm.push(resolve)
  })

  const doTaskInner = (type, size, worker, id) => new Promise((resolve, reject) => {
    workerProm[id] = {resolve, reject}
    worker.send([{type: 'work', args: [{type, bits: size}], id}])
  })

  doTask = async (type, size) => {
    log('start', type, size)
    const worker = await getWorker()
    log('do', type, size)
    let id = Math.random()
    return doTaskInner(type, size, worker, id)
  }

  cluster.on('message', (worker, msg) => {
    msg.forEach(m => {
      switch (m.type) {
        case 'ready':
          if (waitingProm.length) {
            waitingProm.shift()(worker)
          } else {
            readyWorkers.push(worker)
          }
          break
        case 'result':
          workerProm[m.id][m.action](m.result)
          delete workerProm[m.id]
          break
        default: throw new TypeError(m.type)
      }
    })
  })

  cluster.on('exit', (worker, code, signal) => {
    console.log(`worker ${worker.process.pid} died`)
  })

  const server = Hapi.server({
    port: 5484,
    host: 'localhost'
  })

  const init = async () => {
    commonPairs.forEach(pair => prepareCache(...pair))
    uncommonPairs.forEach(pair => prepareCache(...pair))
    await fillCache()
    await server.register(require('inert'))
    await server.start()
    console.log(`Server running at: ${server.info.uri}`)
  }

  const TYPES = ['rsa']

  const handler = async (request, h) => {
    let bits = parseInt(request.params.bits, 10)
    if (isNaN(bits)) {
      return h.response({error: 'Bits is not a number', code: 'EBITSNAN'}).code(400)
    }
    if (TYPES.indexOf(request.params.type) === -1) {
      return h.response({error: 'Type not supported', code: 'EUNSUPPORTED'}).code(400)
    }
    if (request.params.type === 'rsa' && (bits > 16384 || bits < 512)) {
      return h.response({error: 'Bits count too small/big', code: 'EBITSUNSUPPORTED'}).code(400)
    }

    return getKey(request.params.type, request.params.bits)
  }

  server.route({
    method: 'GET',
    path: '/{type}/{bits}',
    handler
  })

  server.route({
    method: 'POST',
    path: '/{type}/{bits}',
    handler
  })

  server.route({
    method: 'GET',
    path: '/',
    handler: (request, h) => h.file(path.join(__dirname, 'public/index.html'), {confine: false})
  })

  init()
} else {
  process.on('message', (msg) => {
    msg.forEach(m => {
      switch (m.type) {
        case 'work':
          Id.create(...m.args, (err, key) => {
            log('get work %o', m)
            let msg = {type: 'result', id: m.id}
            if (err) {
              msg.action = 'reject'
              msg.result = err
            } else {
              msg.action = 'resolve'
              msg.result = key.toJSON()
            }
            log('done work %o', msg.action)
            process.send([msg, {type: 'ready'}])
          })
          break
        case 'exit':
          return process.exit(0)
        default: throw new TypeError(m.type)
      }
    })
  })

  process.send([{type: 'ready'}])
}

process.on('unhandledRejection', (err) => {
  console.log(err)
  process.exit(1)
})
