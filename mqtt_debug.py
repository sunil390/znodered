import paho.mqtt.client as mqtt
import time

msgs = []

def on_message(client, userdata, message):
    topic_part = message.topic.split("/")[-2]
    # For binary_sensor topics, use a different split
    if "binary_sensor" in message.topic:
        topic_part = "DETECTED"
    val = message.payload.decode()
    ts = f"{time.time():.3f}"
    msgs.append(f"{ts} {topic_part}: {val}")

c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
c.on_message = on_message
c.connect("192.168.2.251", 1883)
c.subscribe("home/radar/sensor/target_count/state")
c.subscribe("home/radar/binary_sensor/target_detected/state")
c.loop_start()
time.sleep(30)
c.loop_stop()
print(f"Total messages: {len(msgs)}")
for m in msgs:
    print(m)
