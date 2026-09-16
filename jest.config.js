module.exports = {
  // Only run true Jest tests. The rest of the *.test.js files in this
  // repository are custom Node.js scripts that use their own test() runner
  // and run asynchronously, causing Jest teardown errors if picked up.
  testMatch: [
    "**/phase27.test.js",
    "**/phase32ProvenanceAudit.test.js",
    "**/auth/phase35a.auth.test.js",  // Phase 35A
    "**/alerts/phase35b.alertCrud.test.js", // Phase 35B
    "**/alerts/phase35c.alertEvaluation.test.js", // Phase 35C
    "**/alerts/phase35d.batchEvaluation.test.js", // Phase 35D
    "**/alerts/phase35e.notification.test.js", // Phase 35E
    "**/alerts/phase35f.trigger.test.js", // Phase 35F
  ]
};
