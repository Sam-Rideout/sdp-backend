"""Independent availability reporting for the supervised customer worker."""

import threading


def start_heartbeat(publish, report_error, interval=120):
    """Start a reporting thread and return a shutdown function."""

    stop = threading.Event()

    def loop():
        while not stop.is_set():
            try:
                publish()
            except Exception as error:
                try:
                    report_error(error)
                except Exception:
                    pass

            if stop.wait(interval):
                break

    thread = threading.Thread(
        target=loop,
        name="PX-Profile-Availability",
        daemon=True,
    )

    thread.start()

    def shutdown():
        stop.set()
        thread.join(timeout=2)
        return not thread.is_alive()

    return shutdown
