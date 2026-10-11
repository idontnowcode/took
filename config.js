// 입력 앱 설정. clientId가 비어 있으면 모의 모드(이 브라우저 안에만 저장)로 동작한다.
// Google Cloud에서 OAuth 클라이언트(웹 애플리케이션, 범위 drive.file)를 만든 뒤 클라이언트 ID를 넣는다.
// 클라이언트 ID는 비밀값이 아니다(브라우저에 그대로 노출되는 값). 보안 비밀(client secret)은 쓰지 않는다.
window.APP_CONFIG = {
  clientId: '',                 // 예: '1234-abcd.apps.googleusercontent.com'
  folderName: '빠른입력',       // 앱이 만드는 전용 폴더 이름(Drive 루트에 생성 → 00_Inbox 안으로 한 번 옮긴다)
  appSubfolder: '_앱'           // 요약·목록 사본을 두는 하위 폴더(분류 대상 아님)
};
