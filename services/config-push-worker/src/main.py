"""Entry-point for the Config Push Worker."""
import asyncio
import json
import logging
import signal
import sys

from prometheus_client import start_http_server

from .config import Config

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("config-push-worker")


async def main():
    try:
        import motor.motor_asyncio as motor  # noqa: PLC0415
        from aiokafka import AIOKafkaConsumer  # noqa: PLC0415
    except ImportError as e:
        log.error("Required dependency not installed: %s — exiting", e)
        sys.exit(1)

    from .worker import ConfigPushWorker  # noqa: PLC0415

    mongo = motor.AsyncIOMotorClient(Config.MONGO_URI)
    db = mongo[Config.MONGO_DB]
    worker = ConfigPushWorker(db)

    # Start Prometheus metrics
    start_http_server(Config.METRICS_PORT)
    log.info("Prometheus metrics on port %d", Config.METRICS_PORT)

    consumer = AIOKafkaConsumer(
        Config.KAFKA_TOPIC_CONFIG_PUSH,
        Config.KAFKA_TOPIC_DEVICE_CHECKIN,
        bootstrap_servers=Config.KAFKA_BROKERS,
        group_id=Config.KAFKA_GROUP_ID,
        enable_auto_commit=False,
    )
    await consumer.start()
    log.info("Kafka consumer started — topics: %s, %s",
             Config.KAFKA_TOPIC_CONFIG_PUSH, Config.KAFKA_TOPIC_DEVICE_CHECKIN)

    stop_event = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop_event.set)

    try:
        async for msg in consumer:
            if stop_event.is_set():
                break
            try:
                event = json.loads(msg.value.decode())
                if msg.topic == Config.KAFKA_TOPIC_DEVICE_CHECKIN:
                    device_id = event.get("deviceId") or event.get("serialNumber")
                    if device_id:
                        drained = await worker.drain_pending_commands(device_id)
                        log.info("Drained %d pending commands for %s", drained, device_id)
                else:
                    result = await worker.handle_push_event(event)
                    log.info("Config push result: %s", result)
                await consumer.commit()
            except Exception as exc:
                log.error("Error processing message: %s", exc)
    finally:
        await consumer.stop()
        mongo.close()


if __name__ == "__main__":
    asyncio.run(main())
