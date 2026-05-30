// pages/_app.js
import "../styles/globals.css";
import { SettingsProvider } from "../context/SettingsContext";

export default function App({ Component, pageProps }) {
  return (
    <SettingsProvider>
      <Component {...pageProps} />
    </SettingsProvider>
  );
}
