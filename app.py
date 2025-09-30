import os

from flask import Flask, send_file

app = Flask(__name__)

@app.route("/")
def index():
    return "Hello world!"

@app.route("/workers_wake_up")
def workers_wake_up():
    return "Hey!Wake Up!!"

@app.route("/test")
def test():
    print("this is a test print")
    app.logger.info("Request test success!")
    return "this is a test print"

def main():
    port = int(os.environ.get('PORT', 5000))
    print(f"App is Running at {port} port!")
    app.run(host='0.0.0.0', port=port))

if __name__ == "__main__":
    main()
