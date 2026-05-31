from flask import Flask, render_template
app = Flask(__name__)

@app.route("/")
def dashboard():
    return render_template("dashboard.html")

@app.route("/employee")
def employee():
    from analytics.employee import get_employee_stats
    data = get_employee_stats()
    return data

@app.route("/inventory")
def inventory():
    from analytics.inventory import get_inventory_stats
    data = get_inventory_stats()
    return data

@app.route("/sales")
def sales():
    from analytics.sales import get_sales_stats
    data = get_sales_stats()
    return data

@app.route("/basket")
def basket():
    from analytics.basket import get_basket_stats
    data = get_basket_stats()
    return data

if __name__ == "__main__":
    import os
    app.run(
        host='0.0.0.0',
        port=int(os.environ.get('PORT', 5000)),
        debug=False
    )