package it.baustelle.mailtest;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;

/**
 * Test: Kann eine App eine fertige Mail mit Empfänger, Betreff, Text
 * und mehreren Anhängen (Foto + PDF) an eM Client übergeben?
 */
public class MainActivity extends Activity {

    private static final String EM_CLIENT = "com.emclient.mailclient";
    private EditText empfaenger;
    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        int pad = dp(16);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad * 2, pad, pad);

        TextView titel = new TextView(this);
        titel.setText("Mail-Test für die Baustellen-App");
        titel.setTextSize(22);
        titel.setTextColor(Color.BLACK);
        root.addView(titel);

        TextView info = new TextView(this);
        info.setText("Erzeugt ein Testfoto und ein Test-PDF und öffnet damit eine fertige Mail. "
                + "Bitte danach in eM Client prüfen: Sind Empfänger, Betreff, Text, Foto und PDF da? "
                + "Die Mail muss NICHT verschickt werden.");
        info.setPadding(0, pad / 2, 0, pad);
        root.addView(info);

        TextView l = new TextView(this);
        l.setText("Empfänger (zum Test am besten deine eigene Adresse):");
        root.addView(l);
        empfaenger = new EditText(this);
        empfaenger.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        empfaenger.setHint("name@beispiel.it");
        root.addView(empfaenger);

        root.addView(knopf("1 · Direkt in eM Client öffnen", v -> senden(true, true)));
        root.addView(knopf("2 · Mail-App auswählen (Foto + PDF)", v -> senden(false, true)));
        root.addView(knopf("3 · Direkt in eM Client, nur Foto", v -> senden(true, false)));

        status = new TextView(this);
        status.setPadding(0, pad, 0, 0);
        root.addView(status);

        ScrollView sv = new ScrollView(this);
        sv.addView(root);
        setContentView(sv);
    }

    private Button knopf(String text, android.view.View.OnClickListener cl) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setOnClickListener(cl);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(12);
        b.setLayoutParams(lp);
        return b;
    }

    private void senden(boolean nurEmClient, boolean mitPdf) {
        try {
            File dir = new File(getCacheDir(), "anhaenge");
            dir.mkdirs();
            String zeit = new SimpleDateFormat("dd.MM.yyyy HH:mm", Locale.GERMANY).format(new Date());

            ArrayList<Uri> uris = new ArrayList<>();
            uris.add(uri(testFoto(new File(dir, "Testfoto_Baustelle.jpg"), zeit)));
            if (mitPdf) uris.add(uri(testPdf(new File(dir, "Beteiligtenliste_Test.pdf"), zeit)));

            String adr = empfaenger.getText().toString().trim();
            Intent i = new Intent(uris.size() > 1 ? Intent.ACTION_SEND_MULTIPLE : Intent.ACTION_SEND);
            i.setType(mitPdf ? "*/*" : "image/jpeg");
            if (!adr.isEmpty()) i.putExtra(Intent.EXTRA_EMAIL, new String[]{adr});
            i.putExtra(Intent.EXTRA_SUBJECT, "Test Baustellen-App – Silikonfuge Bad OG");
            i.putExtra(Intent.EXTRA_TEXT, "Sehr geehrte Damen und Herren,\n\n"
                    + "dies ist eine Testmail der Baustellen-App (" + zeit + ").\n"
                    + "Im Anhang sollten ein Foto" + (mitPdf ? " und ein PDF" : "") + " sein.\n");
            if (uris.size() > 1) {
                i.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            } else {
                i.putExtra(Intent.EXTRA_STREAM, uris.get(0));
            }
            ClipData clip = ClipData.newRawUri("Anhang", uris.get(0));
            for (int n = 1; n < uris.size(); n++) clip.addItem(new ClipData.Item(uris.get(n)));
            i.setClipData(clip);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            if (nurEmClient) {
                i.setPackage(EM_CLIENT);
                if (i.resolveActivity(getPackageManager()) == null) {
                    zeige("eM Client wurde nicht gefunden. Ist die App installiert? Probier Knopf 2.");
                    return;
                }
                startActivity(i);
            } else {
                startActivity(Intent.createChooser(i, "Mail senden mit …"));
            }
            zeige("Mail geöffnet (" + uris.size() + " Anhang/Anhänge). Bitte in eM Client prüfen.");
        } catch (Exception e) {
            zeige("Fehler: " + e);
        }
    }

    private Uri uri(File f) {
        return FileProvider.getUriForFile(this, "it.baustelle.mailtest.files", f);
    }

    private File testFoto(File f, String zeit) throws Exception {
        Bitmap bmp = Bitmap.createBitmap(1200, 900, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        c.drawColor(Color.rgb(232, 163, 23));
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(Color.rgb(29, 36, 40));
        p.setTextSize(80);
        c.drawText("Testfoto Baustelle", 80, 380, p);
        p.setTextSize(50);
        c.drawText(zeit, 80, 480, p);
        try (FileOutputStream out = new FileOutputStream(f)) {
            bmp.compress(Bitmap.CompressFormat.JPEG, 85, out);
        }
        return f;
    }

    private File testPdf(File f, String zeit) throws Exception {
        PdfDocument doc = new PdfDocument();
        PdfDocument.Page page = doc.startPage(new PdfDocument.PageInfo.Builder(595, 842, 1).create());
        Canvas c = page.getCanvas();
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setTextSize(22);
        p.setFakeBoldText(true);
        c.drawText("Beteiligtenliste (Test)", 50, 80, p);
        p.setFakeBoldText(false);
        p.setTextSize(12);
        c.drawText("Erstellt: " + zeit, 50, 105, p);
        c.drawText("Fliesen · Eurokeramik · 348 3851285", 50, 150, p);
        c.drawText("Elektriker · Elektro Riegler GmbH · 345 8127757", 50, 170, p);
        doc.finishPage(page);
        try (FileOutputStream out = new FileOutputStream(f)) {
            doc.writeTo(out);
        }
        doc.close();
        return f;
    }

    private void zeige(String s) {
        status.setText(s);
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
