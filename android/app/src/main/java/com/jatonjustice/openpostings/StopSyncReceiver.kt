package com.jatonjustice.openpostings

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Process
import com.asterinet.react.bgactions.RNBackgroundActionsTask

class StopSyncReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION_STOP_SYNC = "com.jatonjustice.openpostings.action.STOP_SYNC"
  }

  override fun onReceive(context: Context, intent: Intent?) {
    if (intent?.action != ACTION_STOP_SYNC) {
      return
    }

    context.stopService(Intent(context, RNBackgroundActionsTask::class.java))

    val notificationManager =
      context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
    notificationManager?.cancel(RNBackgroundActionsTask.SERVICE_NOTIFICATION_ID)

    // Ensure embedded Node runtime and foreground task both stop immediately.
    Process.killProcess(Process.myPid())
  }
}
