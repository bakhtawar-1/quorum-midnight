#!/usr/bin/env bash
set -u
API=http://localhost:8787
j() { curl -s -H 'content-type: application/json' "$@"; }

echo "== enroll citizen-1 -> alice-1 =="
j -X POST $API/api/enroll -d '{"credentialId":"citizen-1","reporterKey":"alice-1"}'; echo
echo "== enroll citizen-2 -> bob-2 =="
j -X POST $API/api/enroll -d '{"credentialId":"citizen-2","reporterKey":"bob-2"}'; echo

echo "== file alice-1 vs Jordan Blake =="
R1=$(j -X POST $API/api/report -d '{"accusedLabel":"Jordan Blake","reporterSecret":"alice-1","ciphertext":"Q1Q","iv":"aXY"}')
echo "$R1"
BK=$(echo "$R1" | grep -oP '"bucketKeyHex":"\K[0-9a-f]+')
RID=$(echo "$R1" | grep -oP '"reportId":"\K[^"]+')
echo "bucket=$BK report=$RID"

echo "== browser would split the key; here we store dummy shares on each node =="
for n in 8801 8802 8803; do
  j -X POST http://localhost:$n/store -d "{\"bucketKeyHex\":\"$BK\",\"reportId\":\"$RID\",\"share\":\"dummy-share-$n\"}"; echo
done

echo "== ask node 1 for its share while bucket is SEALED (expect 403) =="
curl -s -w ' [%{http_code}]\n' "http://localhost:8801/share?bucketKeyHex=$BK&reportId=$RID"

echo "== file bob-2 vs Jordan Blake (crosses threshold) =="
R2=$(j -X POST $API/api/report -d '{"accusedLabel":"Jordan Blake","reporterSecret":"bob-2","ciphertext":"REVG","iv":"aXY"}')
echo "$R2"
for n in 8801 8802 8803; do
  j -X POST http://localhost:$n/store -d "{\"bucketKeyHex\":\"$BK\",\"reportId\":\"$(echo "$R2" | grep -oP '"reportId":"\K[^"]+')\",\"share\":\"dummy-r2-$n\"}"; echo
done

echo "== now ask ALL nodes for report 1's share (expect 200 + share) =="
for n in 8801 8802 8803; do
  curl -s -w " [%{http_code}]\n" "http://localhost:$n/share?bucketKeyHex=$BK&reportId=$RID"
done

echo "== state =="
j $API/api/state
echo
echo DONE
