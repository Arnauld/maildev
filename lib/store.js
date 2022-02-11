'use strict'

const os = require('os')
const defaultConfig = {
    mailDir: path.join(os.tmpdir(), `maildev-${process.pid.toString()}`)
}

class MessageHandler {
    constructor({mailDir, id, envelope}) {
        this.mailDir = mailDir
        this.id = id
        this.envelope = envelope
        this.attachments = []
    }
    text(data) {
        this.text = data
    }
    headers(headers) {
        this.headers = headers
    }
    emlPath() {
        return path.join(this.mailDir, id + '.eml')
    }
    emlWriteStream() {
        return fs.createWriteStream(this.emlPath())
    }
    attachmentDir() {
        return path.join(this.mailDir, id)
    }
    newAttachmentWriteStream(attachment) {
        const dir = this.attachmentDir()
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir)
        }
        this.attachments.push(attachment)
        return fs.createWriteStream(path.join(dir, attachment.contentId))
    }
    persist() {
        
    }
}

class Store {
    constructor(config) {
        this.config = {...defaultConfig, ...config}
    }
    save() {}

    newMessageHandler(id, parsedEmail) {
        return new MessageHandler({
            mailDir: this.config.mailDir, 
            id, 
            parsedEmail
        })
    }
}

module.exports = {
    MessageHandler,
    Store
}