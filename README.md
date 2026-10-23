# Tailscale Manager

울산 프로젝트용 데스크톱 앱입니다. 내 PC의 Tailscale을 켜고 끄고, 울산 Windows PC를 경유지로 삼아
내부망 DB·서버로 SSH 터널을 엽니다. (기존 "울산 연결" 앱의 `ssh -L` 방식과 같습니다.)

## 1단계 기능
- Tailscale 상태 보기, 켜기/끄기 (`tailscale up` / `tailscale down`), 노드 목록
- 경유지(울산 Windows PC) 하나에 SSH로 붙어 여러 포트 포워딩을 동시에 유지
  - 울산 운영 DB `127.0.0.1:15432` → `10.10.11.100:5432`
  - 업체 DB `127.0.0.1:15433` → `10.10.11.201:15431`
  - dashboard, nginx 등 SSH 서버
- DB 연결 테스트: Tailscale → 경유지 PC 온라인 → 터널 → PostgreSQL 응답 순서로 확인 (DB 비밀번호 불필요)
- JDBC 주소, psql 명령, ssh 명령 복사
- SSH 키 등록: 앱 전용 ed25519 키를 만들어 Windows 경유지(관리자 계정이면 `administrators_authorized_keys`)와 Linux 서버에 등록
- 기존 "울산 연결" 앱 설정(`~/Library/Application Support/UlsanConnect/connections.json`) 가져오기
- 외부 실행 링크 `tailscale-manager://upload?file=...&server=...` 수신 (업로드 자체는 3단계)

## 실행
Node 20.19 이상이 필요합니다. nvm을 쓰면 폴더에서 `nvm use`로 맞출 수 있습니다 (`.nvmrc` = 22).

```bash
npm install
npm start          # 빌드 후 실행
npm run dev        # 개발 모드 (화면 수정 시 바로 반영)
npm test           # 테스트
npm run dist:mac   # Mac 설치 파일(dmg) 만들기, release/ 폴더
npm run dist:win   # Windows 설치 파일 (Windows에서 실행)
```

## 사용 순서
1. 상단 "켜기"로 Tailscale을 켭니다.
2. 처음이면 "설정 → 기존 울산 연결 앱 설정 가져오기"를 눌러 서버 목록을 불러옵니다.
3. "울산 운영 DB"의 "연결"을 누르고 Windows 비밀번호를 입력합니다. 처음엔 서버 지문 확인 창이 뜹니다.
4. DataGrip에서는 `127.0.0.1:15432`로 접속합니다. (DataGrip의 SSH 터널 옵션은 끕니다)
5. 경유지 카드의 "SSH 키 등록"을 한 번 하면 다음부터 비밀번호를 묻지 않습니다.

## 주의
- 기존 "울산 연결" 앱이 같은 포트(15432 등)를 쓰고 있으면 이 앱에서 연결할 수 없습니다. 한쪽에서만 연결하세요.
  기존 앱이 연 터널이라도 "연결 테스트"는 DB 응답을 확인해 줍니다.
- 비밀번호는 저장하지 않습니다.
- 데이터 위치: `~/.tailscale-manager/` (`config.json`, `known_hosts.json`, `keys/id_ed25519`)
- 서버 지문은 이 앱 저장값 → `~/.ssh/known_hosts` 순서로 확인합니다. 기존에 터미널로 접속한 적이 있으면 지문 확인 창이 뜨지 않습니다.

## 다음 단계
2단계 앱 안 SSH 터미널 → 3단계 SFTP 파일 탐색기(+ 프로젝트 관리 도구 "올리기" 연동) → 4단계 편의 기능
