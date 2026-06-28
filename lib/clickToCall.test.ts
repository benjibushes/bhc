import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedTwilioRecordingUrl } from './clickToCall';

// transcribeRecording attaches Twilio Basic auth to this fetch, so the
// allowlist is the line that prevents SSRF + credential exfiltration from a
// spoofed RecordingUrl. Lock both the allow and (especially) the deny set.

const ALLOWED = [
  'https://api.twilio.com/2010-04-01/Accounts/ACxxx/Recordings/RExxx',
  'https://api.twilio.com/foo.mp3',
  'https://media.twilio.com/recording',
  'https://twilio.com/x',
];

const DENIED = [
  'http://api.twilio.com/x', // not https — creds would go over plaintext
  'https://evil.com/x',
  'https://twilio.com.evil.com/x', // suffix-confusion
  'https://eviltwilio.com/x', // no dot boundary before twilio.com
  'https://169.254.169.254/latest/meta-data/', // cloud metadata SSRF
  'http://169.254.169.254/',
  'file:///etc/passwd',
  'not a url',
  '',
];

for (const url of ALLOWED) {
  test(`isAllowedTwilioRecordingUrl ALLOWS ${url}`, () => {
    assert.equal(isAllowedTwilioRecordingUrl(url), true);
  });
}

for (const url of DENIED) {
  test(`isAllowedTwilioRecordingUrl DENIES ${url}`, () => {
    assert.equal(isAllowedTwilioRecordingUrl(url), false);
  });
}
