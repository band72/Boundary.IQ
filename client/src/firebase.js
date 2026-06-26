import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyCfCreItJCbR4EI6qNmRMoOaUajiSgNweU",
  authDomain: "gen-lang-client-0357875004.firebaseapp.com",
  projectId: "gen-lang-client-0357875004",
  storageBucket: "gen-lang-client-0357875004.firebasestorage.app",
  messagingSenderId: "318563891368",
  appId: "1:318563891368:web:b20182ae1be400a96fea9d"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
