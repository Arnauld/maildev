const nodemon = require('nodemon')
const {sendEmailsOnceReady} = require('./send.js')

nodemon({
  script: './bin/maildev',
  verbose: true,
  watch: [
    'index.js',
    'lib/*'
  ],
  args: [
    '--verbose'
  ]
}).on('start', function () {
  sendEmailsOnceReady(5000)
}).on('crash', function () {
  console.log('Nodemon process crashed')
})
