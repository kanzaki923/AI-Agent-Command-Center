; Installer hooks (tauri.conf.json bundle.windows.nsis.installerHooks).
;
; The Core Daemon (acc-node.exe) keeps running after the window closes, by design. Tauri's own
; check only looks at acc-desktop.exe, so without this the daemon keeps acc-node.exe and
; daemon\main.mjs open: an uninstall leaves them behind and an update cannot replace them.
;
; Order matters: the app first, because it starts a new daemon as soon as the old one is gone.
; The daemon is killed, not asked to stop: work in progress shows up as 中断 next time and
; can be resumed (the same as a crash).

!macro ACC_STOP_APP_AND_DAEMON
  ; nsis_tauri_utils: FindProcess* pushes 0 when a process with that name exists.
  nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $R0
  nsis_tauri_utils::FindProcessCurrentUser "acc-node.exe"
  Pop $R1
  ${If} $R0 = 0
  ${OrIf} $R1 = 0
    ${If} $PassiveMode <> 1
      MessageBox MB_OKCANCEL|MB_ICONINFORMATION "${PRODUCTNAME} を終了してから続けます。$\n動いている作業は中断します（あとで再開できます）。" /SD IDOK IDOK +2
      Abort
    ${EndIf}
    nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
    Pop $R0
    nsis_tauri_utils::KillProcessCurrentUser "acc-node.exe"
    Pop $R1
    ; Termination is asynchronous: wait (up to 10 s) until both are really gone, so Tauri's own
    ; check that follows finds nothing and the files are no longer held open.
    ${For} $R2 1 40
      Sleep 250
      nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
      Pop $R0
      nsis_tauri_utils::FindProcessCurrentUser "acc-node.exe"
      Pop $R1
      ${If} $R0 <> 0
      ${AndIf} $R1 <> 0
        ${Break}
      ${EndIf}
    ${Next}
    Sleep 500
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ACC_STOP_APP_AND_DAEMON
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro ACC_STOP_APP_AND_DAEMON
!macroend