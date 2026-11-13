package it.baustelle.doku;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.util.ArrayList;

/**
 * Öffnet eine fertige Mail im Mailprogramm (bevorzugt eM Client)
 * mit Empfängern, Betreff, Text und Anhängen.
 */
@CapacitorPlugin(name = "Mail")
public class MailPlugin extends Plugin {

    private static final String EM_CLIENT = "com.emclient.mailclient";

    @PluginMethod
    public void compose(PluginCall call) {
        try {
            JSArray to = call.getArray("to", new JSArray());
            JSArray files = call.getArray("attachments", new JSArray());
            String subject = call.getString("subject", "");
            String body = call.getString("body", "");
            boolean preferEm = call.getBoolean("preferEmClient", true);

            String[] adr = new String[to.length()];
            for (int i = 0; i < to.length(); i++) adr[i] = to.getString(i);
            JSArray bccArr = call.getArray("bcc", new JSArray());
            String[] bcc = new String[bccArr.length()];
            for (int i = 0; i < bccArr.length(); i++) bcc[i] = bccArr.getString(i);

            ArrayList<Uri> uris = new ArrayList<>();
            String auth = getContext().getPackageName() + ".fileprovider";
            for (int i = 0; i < files.length(); i++) {
                String p = files.getString(i);
                if (p.startsWith("file://")) p = Uri.parse(p).getPath();
                File f = new File(p);
                if (f.exists()) uris.add(FileProvider.getUriForFile(getContext(), auth, f));
            }

            Intent intent;
            if (uris.size() > 1) {
                intent = new Intent(Intent.ACTION_SEND_MULTIPLE);
                intent.setType("*/*");
                intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            } else if (uris.size() == 1) {
                intent = new Intent(Intent.ACTION_SEND);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_STREAM, uris.get(0));
            } else {
                intent = new Intent(Intent.ACTION_SEND);
                intent.setType("message/rfc822");
            }
            if (adr.length > 0) intent.putExtra(Intent.EXTRA_EMAIL, adr);
            if (bcc.length > 0) intent.putExtra(Intent.EXTRA_BCC, bcc);
            intent.putExtra(Intent.EXTRA_SUBJECT, subject);
            intent.putExtra(Intent.EXTRA_TEXT, body);
            if (!uris.isEmpty()) {
                ClipData clip = ClipData.newRawUri("Anhang", uris.get(0));
                for (int n = 1; n < uris.size(); n++) clip.addItem(new ClipData.Item(uris.get(n)));
                intent.setClipData(clip);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }

            boolean viaEm = false;
            if (preferEm) {
                Intent em = new Intent(intent);
                em.setPackage(EM_CLIENT);
                if (em.resolveActivity(getContext().getPackageManager()) != null) {
                    getActivity().startActivity(em);
                    viaEm = true;
                }
            }
            if (!viaEm) {
                getActivity().startActivity(Intent.createChooser(intent, "Mail senden mit …"));
            }
            JSObject ret = new JSObject();
            ret.put("attachments", uris.size());
            ret.put("emClient", viaEm);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Mail konnte nicht geöffnet werden: " + e.getMessage());
        }
    }
}
