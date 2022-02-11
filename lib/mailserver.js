'use strict'

/**
 * MailDev - mailserver.js
 */

const SMTPServer = require('smtp-server').SMTPServer
const events = require('events')
const utils = require('./utils')
const logger = require('./logger')
const smtpHelpers = require('./helpers/smtp')
const outgoing = require('./outgoing')
const {Store} = require('./store')

const eventEmitter = new events.EventEmitter()

const defaultPort = 1025
const defaultHost = '0.0.0.0'

/**
 * Mail Server exports
 */

const mailServer = module.exports = {}


/**
 * SMTP Server stream and helper functions
 */

// Save an email object on stream end
function onNewMessageReceived (serialized) {
  if (outgoing.isAutoRelayEnabled()) {
    mailServer.relayMail(serialized, true, function (err) {
      if (err) logger.error('Error when relaying email', err)
    })
  }

  eventEmitter.emit('new', serialized)
}

/**
 *  Handle smtp-server onData stream
 */
function handleDataStream (stream, session, callback) {
  const id = utils.makeId()
  const envelope = {
    from: session.envelope.mailFrom,
    to: session.envelope.rcptTo,
    host: session.hostNameAppearsAs,
    remoteAddress: session.remoteAddress
  }
  mailServer.store.handleNewMessage(id, envelope, stream, (err, message) => {
    if(message) {
      onNewMessageReceived(message)
      callback(null, 'Message queued as ' + message.id)
    }
    else {
      callback(err)
    }
  })
}

/**
 * Create and configure the mailserver
 */

mailServer.create = function (port, host, mailDir, user, password, hideExtensions) {
  const store = new Store({mailDir})
  store.init()
  mailServer.store = store

  const hideExtensionOptions = getHideExtensionOptions(hideExtensions)
  const smtpServerConfig = Object.assign({
    onAuth: smtpHelpers.createOnAuthCallback(user, password),
    onData: handleDataStream,
    logger: false,
    hideSTARTTLS: true,
    disabledCommands: (user && password) ? ['STARTTLS'] : ['AUTH']
  }, hideExtensionOptions)

  const smtp = new SMTPServer(smtpServerConfig)

  smtp.on('error', mailServer.onSmtpError)

  mailServer.port = port || defaultPort
  mailServer.host = host || defaultHost

  // testability requires this to be exposed.
  // otherwise we cannot test whether error handling works
  mailServer.smtp = smtp
}

const HIDEABLE_EXTENSIONS = [
  'STARTTLS', // Keep it for backward compatibility, but is overriden by hardcoded `hideSTARTTLS`
  'PIPELINING',
  '8BITMIME',
  'SMTPUTF8'
]

function getHideExtensionOptions (extensions) {
  if (!extensions) {
    return {}
  }
  return extensions.reduce(function (options, extension) {
    const ext = extension.toUpperCase()
    if (HIDEABLE_EXTENSIONS.indexOf(ext) > -1) {
      options[`hide${ext}`] = true
    } else {
      throw new Error(`Invalid hideable extension: ${ext}`)
    }
    return options
  }, {})
}

/**
 * Start the mailServer
 */

mailServer.listen = function (callback) {
  if (typeof callback !== 'function') callback = null

  // Listen on the specified port
  mailServer.smtp.listen(mailServer.port, mailServer.host, function (err) {
    if (err) {
      if (callback) {
        callback(err)
      } else {
        throw err
      }
    }

    if (callback) callback()

    logger.info('MailDev SMTP Server running at %s:%s', mailServer.host, mailServer.port)
  })
}

/**
 * Handle mailServer error
 */

mailServer.onSmtpError = function (err) {
  if (err.code === 'ECONNRESET' && err.syscall === 'read') {
    logger.warn(`Ignoring "${err.message}" error thrown by SMTP server. Likely the client connection closed prematurely. Full error details below.`)
    logger.error(err)
  } else throw err
}

/**
 * Stop the mailserver
 */

mailServer.close = function (callback) {
  mailServer.emit('close')
  mailServer.smtp.close(callback)
  outgoing.close()
}

/**
 * Extend Event Emitter methods
 * events:
 *   'new' - emitted when new email has arrived
 */

mailServer.on = eventEmitter.on.bind(eventEmitter)
mailServer.emit = eventEmitter.emit.bind(eventEmitter)
mailServer.removeListener = eventEmitter.removeListener.bind(eventEmitter)
mailServer.removeAllListeners = eventEmitter.removeAllListeners.bind(eventEmitter)

/**
 * Get an email by id
 */

mailServer.getEmail = function (id, done) {
  return mailServer.store.emailById(id, done)
}

/**
 * Returns a readable stream of the raw email
 */

mailServer.getRawEmail = function (id, done) {
  return mailServer.store.emailStreamById(id, done)
}

/**
 * Returns the html of a given email
 */

mailServer.getEmailHTML = function (id, baseUrl, done) {
  if (!done && typeof baseUrl === 'function') {
    done = baseUrl
    baseUrl = null
  }

  if (baseUrl) { baseUrl = '//' + baseUrl }

  mailServer.getEmail(id, function (err, email) {
    if (err) return done(err)

    let html = email.html

    if (!email.attachments) { return done(null, html) }

    const embeddedAttachments = email.attachments.filter(function (attachment) {
      return attachment.contentId
    })

    const getFileUrl = function (id, baseUrl, filename) {
      return (baseUrl || '') + '/email/' + id + '/attachment/' + encodeURIComponent(filename)
    }

    if (embeddedAttachments.length) {
      embeddedAttachments.forEach(function (attachment) {
        const regex = new RegExp('src=("|\')cid:' + attachment.contentId + '("|\')', 'g')
        const replacement = 'src="' + getFileUrl(id, baseUrl, attachment.generatedFileName) + '"'
        html = html.replace(regex, replacement)
      })
    }

    done(null, html)
  })
}

/**
 * Read all emails
 */
mailServer.readAllEmail = function (done) {
  mailServer.store.markAllEmailRead(done)
}

/**
 * Get all email
 */

mailServer.getAllEmail = function (done) {
  done(null, mailServer.store.allEmails())
}

/**
 * Delete an email by id
 */

mailServer.deleteEmail = function (id, done) {
  mailServer.store.deleteById(id, (err, ok) => {
    if(ok) {
      eventEmitter.emit('delete', ok)
      done(null, true)
    }
    else {
      done(err)
    }
  })
}

/**
 * Delete all emails in the store
 */

mailServer.deleteAllEmail = function (done) {
  logger.warn('Deleting all email')

  mailServer.store.deleteAll()
  eventEmitter.emit('delete', { id: 'all' })
  done(null, true)
}

/**
 * Returns the content type and a readable stream of the file
 */

mailServer.getEmailAttachment = function (id, filename, done) {
  mailServer.store.emailAttachmentStreamById(id, filename, done)
}

/**
 * Setup outgoing
 */
mailServer.setupOutgoing = function (host, port, user, pass, secure) {
  outgoing.setup(host, port, user, pass, secure)
}

mailServer.isOutgoingEnabled = function () {
  return outgoing.isEnabled()
}

mailServer.getOutgoingHost = function () {
  return outgoing.getOutgoingHost()
}

/**
 * Set Auto Relay Mode, automatic send email to recipient
 */

mailServer.setAutoRelayMode = function (enabled, rules, emailAddress) {
  outgoing.setAutoRelayMode(enabled, rules, emailAddress)
}

/**
 * Relay a given email, accepts a mail id or a mail object
 */

mailServer.relayMail = function (idOrMailObject, isAutoRelay, done) {
  if (!outgoing.isEnabled()) { return done(new Error('Outgoing mail not configured')) }

  // isAutoRelay is an option argument
  if (typeof isAutoRelay === 'function') {
    done = isAutoRelay
    isAutoRelay = false
  }

  // If we receive a email id, get the email object
  if (typeof idOrMailObject === 'string') {
    mailServer.getEmail(idOrMailObject, function (err, email) {
      if (err) return done(err)
      mailServer.relayMail(email, done)
    })
    return
  }

  const mail = idOrMailObject

  mailServer.getRawEmail(mail.id, function (err, rawEmailStream) {
    if (err) {
      logger.error('Mail Stream Error: ', err)
      return done(err)
    }

    outgoing.relayMail(mail, rawEmailStream, isAutoRelay, done)
  })
}

/**
 * Download a given email
 */
mailServer.getEmailEml = function (id, done) {
  mailServer.store.emailStreamById(id, (err, stream) => {
    if (err) return done(err)

    const filename = email.id + '.eml'

    done(null, 'message/rfc822', filename, stream)
  })
}

mailServer.loadMailsFromDirectory = function () {
  console.error("NOOP Operation (@see store options)")

  // const persistencePath = fs.realpathSync(mailServer.mailDir)
  // fs.readdir(persistencePath, function (err, files) {
  //   if (err) {
  //     logger.error('Error during reading of the mailDir %s', persistencePath)
  //   } else {
  //     store.length = 0
  //     files.forEach(function (file) {
  //       const filePath = persistencePath + '/' + file
  //       if (path.parse(file).ext === '.eml') {
  //         fs.readFile(filePath, 'utf8', function (err, data) {
  //           if (err) {
  //             logger.error('Error during reading of the file %s', filePath)
  //           } else {
  //             const idMail = path.parse(file).name
  //             const parseStream = new MailParser({
  //               streamAttachments: true
  //             })
  //             logger.log('Restore mail %s', idMail)
  //             const envelope = { from: '', to: '', host: 'undefined', remoteAddress: 'undefined' }
  //             parseStream.on('from', function (from) {
  //               envelope.from = from
  //             })
  //             parseStream.on('to', function (to) {
  //               envelope.to = to
  //             })
  //             parseStream.on('end', saveEmailToStore.bind(null, idMail, true, envelope))
  //             parseStream.on('attachment', saveAttachment.bind(null, idMail))
  //             parseStream.write(data)
  //             parseStream.end()
  //           }
  //         })
  //       }
  //     })
  //   }
  // })
}
