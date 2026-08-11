; Keep the electron-builder install flow intact while applying a restrained,
; modern visual treatment to the assisted installer pages.
!define MUI_FONT "Microsoft YaHei UI"
!define MUI_FONTSIZE 9
!define MUI_DIRECTORYPAGE_TEXT_TOP "选择安装位置，然后点击“安装”。"
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "安装位置"
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "衡准工作台已安装完成。$\r$\n$\r$\n点击“完成”启动应用。"
!define MUI_FINISHPAGE_RUN_TEXT "启动衡准工作台"

; Keep the user-facing installation folder stable and independent from the
; product's Chinese display name. When a user selects a drive root (for
; example D:\), electron-builder's assisted installer appends APP_FILENAME
; immediately before installation. EquiGrade is the intended folder name.
!ifdef APP_FILENAME
  !undef APP_FILENAME
!endif
!define APP_FILENAME "EquiGrade"

BrandingText "衡准工作台"

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "衡准工作台"
  !define MUI_WELCOMEPAGE_TEXT "自动改卷工作台已准备就绪。$\r$\n$\r$\n点击“下一步”选择安装位置。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

; A per-user install avoids an unnecessary scope choice and UAC prompt. The
; uninstaller still uses electron-builder's original mode-detection behavior.
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    StrCpy $isForceCurrentInstall "1"
  !endif
!macroend

!macro customHeader
  !define MUI_ABORTWARNING
!macroend
