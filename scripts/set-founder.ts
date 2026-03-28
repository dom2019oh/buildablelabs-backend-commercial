// One-time script — sets founder role for a user by email
import admin from 'firebase-admin';
import serviceAccount from 'C:/Users/dom20/Downloads/buildablelabs-42259-firebase-adminsdk-fbsvc-10c8f906a4.json';

admin.initializeApp({ credential: admin.credential.cert(serviceAccount as admin.ServiceAccount) });

const TARGET_EMAIL = 'dom2019ogsapd@gmail.com';

async function run() {
  const userRecord = await admin.auth().getUserByEmail(TARGET_EMAIL);
  console.log(`Found user: ${userRecord.uid}`);

  await admin.auth().setCustomUserClaims(userRecord.uid, { role: 'founder' });
  console.log('Custom claim set: role=founder');

  await admin.firestore().collection('users').doc(userRecord.uid).set({
    role: 'founder',
    isFounder: true,
  }, { merge: true });
  console.log('Firestore updated');

  console.log('Done.');
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
