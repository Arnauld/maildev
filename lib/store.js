'use strict'

const os = require('os')
const fs = require('fs')
const path = require('path')
const utils = require('./utils')
const logger = require('./logger')
const stripTags = require('strip-tags')
const { MailParser } = require('mailparser')

const defaultConfig = {
    mailDir: path.join(os.tmpdir(), `maildev-${process.pid.toString()}`)
}

const copy = (src, srcKey, dst, dstKey, defaultValue) => {
    if (src[srcKey])
        dst[dstKey] = src[srcKey]
    else if (defaultValue)
        dst[dstKey] = defaultValue
}

const parseMessage = (parseOpts, envelope, inStream, outStreams, callback) => {
    const message = { ...envelope, attachments: []}
    const parseStream = new MailParser(parseOpts)
    parseStream.on('headers', headers => {
        copy(headers, 'from', message, 'from', headers['sender'])
        copy(headers, 'to', message, 'to')
        copy(headers, 'cc', message, 'cc')
        copy(headers, 'bcc', message, 'bcc')
        copy(headers, 'sender', message, 'sender')
        copy(headers, 'reply-to', message, 'replyTo')
        copy(headers, 'delivered-to', message, 'deliveredTo')
        copy(headers, 'return-path', message, 'returnPath')
        copy(headers, 'priority', message, 'priority')
        copy(headers, 'subject', message, 'subject')
        copy(headers, 'content-type', message, 'contentType')
        copy(headers, 'content-disposition', message, 'contentDisposition')
        copy(headers, 'dkim-signature', message, 'dkimSignature')
        copy(headers, 'date', message, 'time', new Date())
    })
    parseStream.on('data', data => {
        if (data.type === 'attachment') {
            const attachment = {
                filename: data.filename,
                contentType: data.contentType,
                contentDisposition: data.contentDisposition,
                checksum: data.checksum,
                size: data.size,
                headers: data.headers,
                contentId: data.cid,
                related: data.related
            }
            message.attachments.push(attachment)

            // TODO read the 'streamAttachments' options behavior...
            if(parseOpts.streamAttachments) {
                const {source, stream} = outStreams.attachmentWriteStream(attachment)
                attachment.source = source
                if(!stream) {
                    throw new Error('Do not ask for \'streamAttachments\' if no write stream can be opened')
                }
                data.content.pipe(stream)
                data.content.on('end', () => {
                    stream.end()
                    data.release()
                })
            }
            
        }
        else if (data.type === 'text') {
            copy(data.text, 'text', message, 'text')
            copy(data.text, 'html', message, 'html') // stripTags(html, ['script'])
            copy(data.text, 'textAsHtml', message, 'textAsHtml')
        }
    })

    const {source, emlStream} = outStreams.emlStream()
    if(emlStream) {
        message.source = source
        inStream.pipe(emlStream)
    }
    inStream.pipe(parseStream)

    let size = 0;
    inStream.on('data', function(chunk) {
        size += chunk.length
    })
    inStream.on('end', function () {
        if(emlStream)
            emlStream.end()
        message.size = size
        message.sizeHuman = utils.formatBytes(size)
        callback(null, message)
    })
}

class Store {
    constructor(config) {
        this.config = {
            ...defaultConfig, 
            ...config,
            mailDir: config.mailDir || defaultConfig.mailDir
        }
        console.log('Store config', this.config)
        this.messages = []
    }

    init() {
        const rootDir = this.config.mailDir
        if (!fs.existsSync(rootDir)) {
            fs.mkdirSync(rootDir)
        }
        logger.info('MailDev Store using directory %s', rootDir)
        if (this.config.initFromDir) {
            this.#initFromDirectory()
        }
    }

    #initFromDirectory() {

    }

    emailById(id, callback) {
        const email = this.messages.filter(function (element) {
            return element.id === id
        })

        if (email && email.length == 1) {
            callback(null, email[0])
        } else {
            callback(new Error('Email was not found'))
        }
    }

    emailStreamById(id, callback) {
        this.emailById(id, function (err, email) {
            if (err) return callback(err)

            callback(null, fs.createReadStream(email.source))
        })
    }

    emailAttachmentStreamById(id, filename, callback) {
        this.emailById(id, function (err, email) {
            if (err) return callback(err)

            if (!email.attachments || !email.attachments.length) {
                return callback(new Error('Email has no attachments'))
            }

            const match = email.attachments.filter(attachment => attachment.generatedFileName === filename)

            if (!match || match.length === 0) {
                return callback(new Error('Attachment not found'))
            }

            callback(null, match.contentType, fs.createReadStream(match.source))

        })
    }

    markAllEmailRead(callback) {
        let count = 0
        for (let m of this.messages) {
            if (!m.read) {
                count++
                m.read = true
            }
        }
        callback(null, count)
    }


    /**
     * Delete everything in the store
     */
    deleteAll(callback) {
        this.messages.splice(0, this.messages.length)
        const rootDir = this.config.mailDir
        fs.readdir(rootDir, function (err, files) {
            if (err) throw err

            files.forEach(function (file) {
                rimraf(path.join(rootDir, file), function (err) {
                    if (err) throw err
                })
            })
        })
    }

    deleteById(id, callback) {
        let index
        for (let i = 0; i < this.messages.length; i++) {
            if (this.messages[i].id === id) {
                index = i
                break
            }
        }
        if (!index) {
            return callback(new Error('Email not found'))
        }

        const email = this.messages[index]
        let ok
        rimraf(email.source, function (err) {
            if (err) {
                errors.push(err)
            }
            else {
                ok = { id, index }
            }
        })
        rimraf(email.attachmentDir, function (err) {
            if (err) {
                errors.push(err)
            }
        })

        let err
        if (errors.length > 0) {
            err = new Error(errors)
        }

        logger.warn('Deleting email - %s', email.subject)
        this.messages.splice(index, 1)
        callback(err, ok)
    }

    allEmails() {
        return this.messages
    }

    emlPath(id) {
        return path.join(this.config.mailDir, id + '.eml')
    }

    emlWriteStream(id) {
        return fs.createWriteStream(this.emlPath(id))
    }

    attachmentDir(id) {
        return path.join(this.config.mailDir, id)
    }

    attachmentWriteStream(attachment) {
        const dir = this.attachmentDir()
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir)
        }
        const source = path.join(dir, attachment.contentId)
        return {source, stream:fs.createWriteStream(source)}
    }

    handleNewMessage(id, envelope, inStream, callback) {
        const self = this
        const outStreams = {
            emlStream: self.emlWriteStream.bind(self),
            attachmentStream: self.attachmentWriteStream.bind(self)
        }
        const parserOpts = { streamAttachments: true }
        parseMessage(parserOpts, { ...envelope, id }, inStream, outStreams, (err, message) => {
            if (message) {
                logger.log('Saving email: %s, id: %s', message.subject, message.id)
                this.messages.push(message)
            }
            callback(err, message)
        })
    }
}

module.exports = {
    Store
}