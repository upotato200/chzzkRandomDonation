# 너의 차례

치지직 채팅으로 시청자를 모아 룰렛으로 한 명을 고르고, 당첨자의 채팅을 30초 동안 브라우저 TTS로 읽는 방송 진행 도구입니다. 숫자 투표와 가중치 기반 확률 룰렛도 포함합니다.

## Railway 배포

1. 이 폴더를 GitHub 저장소에 올립니다. `.env` 파일은 올리지 않습니다.
2. Railway에서 **New Project → Deploy from GitHub Repo**를 선택해 이 저장소를 연결합니다.
3. 배포가 한 번 끝난 뒤 서비스의 **Settings → Networking → Generate Domain**에서 공개 도메인을 만듭니다. 예를 들어 `https://your-turn-production.up.railway.app`처럼 보입니다.
4. 서비스의 **Variables**에 아래 값을 넣습니다. `APP_ORIGIN`과 `CHZZK_REDIRECT_URI`는 3번에서 만든 실제 주소로 바꿔 넣습니다.
5. 서비스의 Healthcheck Path가 `/health`인지 확인합니다. 이 저장소의 `railway.json`이 자동 설정하지만, 화면에서 한 번 확인하면 됩니다.
6. Variables를 저장하면 Railway가 다시 배포합니다. 배포 주소를 열어 **치지직 연결**을 누르면 됩니다.

| 변수 | Railway에 넣을 값 |
| --- | --- |
| `APP_ORIGIN` | `https://your-turn-production.up.railway.app` |
| `CHZZK_REDIRECT_URI` | `https://your-turn-production.up.railway.app/auth/chzzk/callback` |
| `CHZZK_CLIENT_ID` | 치지직 개발자 센터에서 발급한 Client ID |
| `CHZZK_CLIENT_SECRET` | 치지직 개발자 센터에서 발급한 Client Secret |

`PORT`는 Railway가 자동으로 주므로 직접 추가하지 않습니다. `HOST`도 Railway에서는 필요 없습니다. 로컬에서만 `.env.example`을 복사해 `.env`로 만들고 `HOST=127.0.0.1`을 사용하면 됩니다.

## 치지직 개발자 센터 설정

치지직 개발자 센터에서 앱을 만들고 다음을 설정합니다.

- 로그인 리디렉션 URL: `CHZZK_REDIRECT_URI`와 **한 글자까지 동일한** 주소
- 권한: `유저 정보 조회`, `채팅 메시지 조회`

처음에는 Railway 공개 도메인이 없으므로, Railway에서 도메인을 만든 다음 그 주소를 치지직과 Railway 양쪽에 같은 값으로 등록하는 순서가 안전합니다. Client Secret은 Railway Variables에만 입력합니다.

## 운영 전 확인

- Railway의 로그에서 `/health`가 정상인지 확인합니다.
- 실제 스트리머 계정으로 로그인한 뒤, 치지직 연결 상태가 `연결됨`인지 확인합니다.
- 시청자 계정으로 `!참여`, `!투표1`을 입력해 각각 참가와 투표가 들어오는지 확인합니다.
- 당첨자만 일반 채팅을 쳤을 때 진행자 브라우저 TTS가 읽는지 확인합니다.
- OBS에서 **진행자 브라우저의 오디오**를 캡처하고, 짧은 테스트 녹화로 방송에 실제 소리가 들어가는지 확인합니다.

현재 게임·채팅 연결 상태는 서버 메모리에 있습니다. Railway가 재시작되면 진행 중인 참가자, 투표, 발언권과 로그인 연결이 초기화됩니다. 이 버전은 한 개 복제본으로 운영하세요.

## 로컬 실행

```bash
cp .env.example .env
pnpm install
pnpm start
```

로컬 주소는 `http://localhost:3000`입니다. 실제 치지직 연동 전에는 화면의 **먼저 체험하기**로 룰렛·투표·TTS 흐름을 확인할 수 있습니다.
