# AGENTS.md

homelab에 배포되는 앱 저장소다. 처음 내용은 `ukyi-app/homelab-app-template`에서 왔다. 앱 계약과 개발 방법은 README.md에 있다.

- 공개(public) 저장소다. 시크릿 값, tailnet 이름(`*.ts.net`), Tailscale 주소, 개인 이메일을 코드·로그·이미지에 두지 않는다. 비밀은 `infisical run`으로 환경변수에만 넣는다.
- `.github/CODEOWNERS`는 `* @ukkiee` 한 줄만 둔다. 줄을 더하면 homelab의 자동 배포 조건이 멈춘다.
- `.github/workflows/build.yaml`의 `uses:`는 태그 ref 그대로 둔다(파일 주석).

## Code Review Rules

- Write all review finding titles and descriptions in Korean.
- Write review summaries and explanations in Korean.
- Keep code identifiers, file paths, commands, and quoted code unchanged.
- 리뷰 요약과 모든 리뷰 코멘트(지적 제목·본문·설명)는 한국어로 쓴다.
- P0~P3 우선순위 표시와 그 형식은 그대로 둔다.
