import cv2
import os
import pickle
import requests
import time
from datetime import datetime

FACE_DB_FILE = "lab_members.pkl"
TOLERANCE = 60
ALARM_INTERVAL = 30
BARK_KEY = "pvzbjaksE24KDQffBbcNh"
BARK_URL = f"https://api.day.app/{BARK_KEY}"
CAMERA_INDEX = 0
CAMERA_BACKEND = cv2.CAP_DSHOW
SAVE_INTRUDER_PHOTO = True
ENABLE_ALARM = True

last_alarm_time = {}
waiting_for_name = False
temp_face_feature = None
members = {}


def load_members():
    if os.path.exists(FACE_DB_FILE):
        with open(FACE_DB_FILE, "rb") as f:
            return pickle.load(f)
    return {}


def save_members(members):
    with open(FACE_DB_FILE, "wb") as f:
        pickle.dump(members, f)


def extract_face_feature(face_gray):
    resized = cv2.resize(face_gray, (100, 100))
    hist = cv2.calcHist([resized], [0], None, [128], [0, 256])
    cv2.normalize(hist, hist)
    return hist.flatten()


def compare_faces(feature1, feature2):
    return cv2.norm(feature1, feature2, cv2.NORM_L2)


def identify_face(face_feature, members, threshold=TOLERANCE):
    best_name = None
    best_score = threshold + 1

    if not members:
        return None, 0

    for name, features in members.items():
        for saved_feature in features:
            score = compare_faces(face_feature, saved_feature)
            if score < best_score:
                best_score = score
                best_name = name

    if best_name and best_score <= threshold:
        return best_name, best_score
    return None, best_score


def send_bark_alarm():
    if not ENABLE_ALARM:
        return False

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    message = f"外来人员闯入！\n时间：{now}\n地点：实验室"

    try:
        data = {
            "title": "实验室警报",
            "body": message,
            "sound": "alarm.caf",
            "level": "active"
        }
        requests.post(BARK_URL, json=data, timeout=5)
        print(f"[{now}] 已发送手机报警")
        return True
    except:
        return False


def save_intruder_photo(frame, face_rect):
    if not SAVE_INTRUDER_PHOTO:
        return None

    x, y, w, h = face_rect
    face_img = frame[y:y + h, x:x + w]
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"intruder_{timestamp}.jpg"
    cv2.imwrite(filename, face_img)
    return filename


def main():
    global waiting_for_name, temp_face_feature, members

    members = load_members()

    cap = cv2.VideoCapture(CAMERA_INDEX, CAMERA_BACKEND)
    if not cap.isOpened():
        cap = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_ANY)
    if not cap.isOpened():
        print("无法打开摄像头")
        return

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

    face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

    print("=" * 50)
    print("实验室监控系统启动")
    print(f"启动时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"当前人员库: {len(members)}人")
    print("使用鼠标点击画面上的按钮进行操作")
    print("=" * 50)

    cv2.namedWindow("Laboratory Monitor")

    def mouse_callback(event, x, y, flags, param):
        global waiting_for_name, temp_face_feature, members
        h, w = param["frame_shape"] if "frame_shape" in param else (480, 640)
        button_y = h - 60

        if event == cv2.EVENT_LBUTTONDOWN:
            if 10 <= x <= 120 and button_y <= y <= button_y + 45:
                if len(param["current_faces"]) > 0:
                    fx, fy, fw, fh, ffeature = param["current_faces"][0]
                    temp_face_feature = ffeature
                    waiting_for_name = True
                    print("\n请输入姓名: ")
                else:
                    print("未检测到人脸，请面对摄像头")
            elif 135 <= x <= 250 and button_y <= y <= button_y + 45:
                members = load_members()
                print(f"已重载人员库，共{len(members)}人")

    while True:
        ret, frame = cap.read()
        if not ret:
            continue

        h, w = frame.shape[:2]
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = face_cascade.detectMultiScale(gray, 1.1, 5)

        current_faces = []
        for (x, y, wf, hf) in faces:
            face_roi = gray[y:y + hf, x:x + wf]
            face_feature = extract_face_feature(face_roi)
            current_faces.append((x, y, wf, hf, face_feature))

            if len(members) > 0:
                name, score = identify_face(face_feature, members)
                if name:
                    color = (0, 255, 0)
                    label = name
                else:
                    color = (0, 0, 255)
                    label = "STRANGER"

                    alarm_key = f"{x // 50}_{y // 50}"
                    now_time = time.time()
                    if alarm_key not in last_alarm_time or (now_time - last_alarm_time[alarm_key]) > ALARM_INTERVAL:
                        last_alarm_time[alarm_key] = now_time
                        current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        print(f"\n[警报] {current_time} 发现陌生人!")
                        send_bark_alarm()
                        save_intruder_photo(frame, (x, y, wf, hf))
            else:
                color = (0, 0, 255)
                label = "STRANGER"

            cv2.rectangle(frame, (x, y), (x + wf, y + hf), color, 2)
            cv2.putText(frame, label, (x, y - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

        button_y = h - 60
        cv2.rectangle(frame, (10, button_y), (120, button_y + 45), (0, 200, 0), -1)
        cv2.rectangle(frame, (10, button_y), (120, button_y + 45), (255, 255, 255), 2)
        cv2.putText(frame, "ADD MEMBER", (18, button_y + 28), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)

        cv2.rectangle(frame, (135, button_y), (250, button_y + 45), (0, 100, 200), -1)
        cv2.rectangle(frame, (135, button_y), (250, button_y + 45), (255, 255, 255), 2)
        cv2.putText(frame, "RELOAD", (155, button_y + 28), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)

        if waiting_for_name and temp_face_feature is not None:
            overlay = frame.copy()
            cv2.rectangle(overlay, (0, 0), (w, 50), (0, 0, 0), -1)
            frame = cv2.addWeighted(overlay, 0.7, frame, 0.3, 0)
            cv2.putText(frame, "PLEASE ENTER NAME IN TERMINAL WINDOW", (50, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                        (0, 255, 255), 2)

        current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cv2.putText(frame, current_time, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        cv2.putText(frame, f"MEMBERS: {len(members)}", (10, 55), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)

        cv2.setMouseCallback("Laboratory Monitor", mouse_callback,
                             {"frame_shape": (h, w), "current_faces": current_faces})

        cv2.imshow("Laboratory Monitor", frame)

        if waiting_for_name:
            name = input("")
            if name.strip():
                if name not in members:
                    members[name] = []
                members[name].append(temp_face_feature)
                if len(members[name]) > 3:
                    members[name] = members[name][-3:]
                save_members(members)
                print(f"已录入: {name}")
                print(f"当前人员库共 {len(members)} 人")
            else:
                print("姓名不能为空")
            waiting_for_name = False
            temp_face_feature = None

        key = cv2.waitKey(1) & 0xFF
        if key == ord('q') or key == 27:
            print(f"\n系统关闭时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            break

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()