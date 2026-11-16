package it.baustelle.doku;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * Durchgehendes Diktat: Die Android-Spracherkennung beendet sich nach jeder
 * Sprechpause. Dieses Plugin startet sie dann sofort neu, bis stop() kommt.
 * Ereignisse an die App: "partial" {text}, "final" {text}, "state" {active}, "error" {message}.
 */
@CapacitorPlugin(
    name = "Diktat",
    permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "mic") }
)
public class DiktatPlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private boolean active = false;
    private String language = "de-DE";
    private int fehlerInFolge = 0;
    private String lastPartial = "";

    @PluginMethod
    public void start(PluginCall call) {
        language = call.getString("language", "de-DE");
        if (getPermissionState("mic") != PermissionState.GRANTED) {
            requestPermissionForAlias("mic", call, "micCallback");
            return;
        }
        beginnen(call);
    }

    @PermissionCallback
    private void micCallback(PluginCall call) {
        if (getPermissionState("mic") == PermissionState.GRANTED) beginnen(call);
        else call.reject("Mikrofon nicht erlaubt");
    }

    private void beginnen(PluginCall call) {
        main.post(() -> {
            if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                call.reject("Keine Spracherkennung auf diesem Handy (Google-App installieren)");
                return;
            }
            active = true;
            fehlerInFolge = 0;
            lastPartial = "";
            hoeren();
            status();
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            active = false;
            if (recognizer != null) recognizer.stopListening();
            // Falls kein Endergebnis mehr kommt: zuletzt gezeigten Text übernehmen
            main.postDelayed(() -> { uebernehmen(""); aufraeumen(); }, 1500);
            status();
            call.resolve();
        });
    }

    private void aufraeumen() {
        if (active) return;
        if (recognizer != null) { recognizer.destroy(); recognizer = null; }
    }

    private void status() {
        JSObject o = new JSObject();
        o.put("active", active);
        notifyListeners("state", o);
    }

    private Intent intent() {
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 5000);
        i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 4000);
        i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 15000);
        i.putExtra("android.speech.extra.DICTATION_MODE", true);
        i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
        return i;
    }

    private void hoeren() {
        if (!active) return;
        if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(new Zuhoerer());
        }
        try {
            recognizer.startListening(intent());
        } catch (Exception e) {
            fehler("Start fehlgeschlagen: " + e.getMessage());
        }
    }

    private void neuStarten(long ms) {
        main.postDelayed(() -> {
            if (!active) return;
            if (recognizer != null) recognizer.cancel();
            hoeren();
        }, ms);
    }

    private void fehler(String msg) {
        active = false;
        JSObject o = new JSObject();
        o.put("message", msg);
        notifyListeners("error", o);
        status();
        aufraeumen();
    }

    /** Endergebnis melden; ist es leer, den zuletzt live gezeigten Text nehmen. */
    private void uebernehmen(String t) {
        if (t == null || t.trim().isEmpty()) t = lastPartial;
        lastPartial = "";
        if (t == null || t.trim().isEmpty()) return;
        JSObject o = new JSObject();
        o.put("text", t);
        notifyListeners("final", o);
    }

    private static String erster(Bundle b) {
        ArrayList<String> m = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return (m != null && !m.isEmpty()) ? m.get(0) : "";
    }

    private class Zuhoerer implements RecognitionListener {
        @Override public void onReadyForSpeech(Bundle p) {}
        @Override public void onBeginningOfSpeech() {}
        @Override public void onRmsChanged(float db) {}
        @Override public void onBufferReceived(byte[] b) {}
        @Override public void onEndOfSpeech() {}
        @Override public void onEvent(int t, Bundle p) {}

        @Override
        public void onPartialResults(Bundle b) {
            String t = erster(b);
            if (!t.trim().isEmpty()) lastPartial = t;
            JSObject o = new JSObject();
            o.put("text", t);
            notifyListeners("partial", o);
        }

        @Override
        public void onResults(Bundle b) {
            fehlerInFolge = 0;
            uebernehmen(erster(b));
            if (active) neuStarten(50);
            else { status(); aufraeumen(); }
        }

        @Override
        public void onError(int code) {
            uebernehmen("");
            if (!active) { status(); aufraeumen(); return; }
            switch (code) {
                case SpeechRecognizer.ERROR_NO_MATCH:
                case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                    // nur Stille: einfach weiter zuhören
                    neuStarten(50);
                    break;
                case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                case SpeechRecognizer.ERROR_CLIENT:
                    if (++fehlerInFolge > 5) fehler("Spracherkennung reagiert nicht");
                    else neuStarten(300);
                    break;
                case SpeechRecognizer.ERROR_NETWORK:
                case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                case SpeechRecognizer.ERROR_SERVER:
                    if (++fehlerInFolge > 3) fehler("Kein Netz für die Spracherkennung");
                    else neuStarten(1000);
                    break;
                case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                    fehler("Mikrofon nicht erlaubt");
                    break;
                default:
                    if (++fehlerInFolge > 3) fehler("Spracherkennung-Fehler " + code);
                    else neuStarten(500);
            }
        }
    }

    @Override
    protected void handleOnDestroy() {
        active = false;
        if (recognizer != null) recognizer.destroy();
    }
}
