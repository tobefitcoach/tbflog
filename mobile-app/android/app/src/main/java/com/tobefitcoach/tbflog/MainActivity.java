package com.tobefitcoach.tbflog;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Android's WebView blocks video autoplay by default unless a user just
    // tapped something, even for muted videos - unlike a normal Chrome
    // browser tab, which allows muted autoplay freely. Without this, every
    // <video> in the app (the mobility/stretching flow especially, which
    // autoplays via videoEl.play() with no tap involved) shows as a gray
    // box with a native play button instead of actually playing.
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        bridge.getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
    }
}
