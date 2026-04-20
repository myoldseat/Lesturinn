// ─── Firebase setup — single source of truth ───
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import { getAuth }       from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { getFirestore }  from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getStorage }    from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-storage.js';

// Re-export every SDK function the app uses (change version in ONE place)
export {
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail,
  onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';

export {
  collection, addDoc, setDoc, doc, getDoc, getDocs,
  onSnapshot, query, where, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

export {
  ref, uploadBytes, getDownloadURL
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-storage.js';

const firebaseConfig = {
  apiKey:            'AIzaSyAgTY3Uxd9_ZxixjqLj-sH8V3OhFAzg6DU',
  authDomain:        'lesum-22e85.firebaseapp.com',
  projectId:         'lesum-22e85',
  storageBucket:     'lesum-22e85.firebasestorage.app',
  messagingSenderId: '204392598388',
  appId:             '1:204392598388:web:2dbbe3f476cd78d2ffba21'
};

const app = initializeApp(firebaseConfig);

export const auth    = getAuth(app);
export const db      = getFirestore(app);
export const storage = getStorage(app);
